# Multi-node PukuCloud

How to run more than one agent behind the same control plane — what the
edge does, how agents register, where state lives, and how to add or remove
a node without losing sandboxes.

For the high-level picture see [architecture.md § Multi-node topology](architecture.md#multi-node-topology). This doc is the operator walkthrough.

## Contents

- [How multi-node is wired](#how-multi-node-is-wired)
- [The single switch: `PUKUCLOUD_DB_DSN`](#the-single-switch-pukucloud_db_dsn)
- [Agent registration and heartbeats](#agent-registration-and-heartbeats)
- [Scheduler and lease table](#scheduler-and-lease-table)
- [Pools: `stateful` vs `ephemeral`](#pools-stateful-vs-ephemeral)
- [Burst-spread and the 2026-08-22 incident](#burst-spread-and-the-2026-08-22-incident)
- [Adding a node](#adding-a-node)
- [Removing a node (drain)](#removing-a-node-drain)
- [Failure handling](#failure-handling)
- [Known gaps](#known-gaps)
- [Verifying it works locally](#verifying-it-works-locally)

---

## How multi-node is wired

Three things have to exist for multi-node:

1. **A shared Postgres** reachable from every api process and every agent
   process. Same schema; same tables (`agents`, `leases`, `sandboxes`,
   `sandbox_events`, …). On Cloudflare, the Workers control plane uses D1
   instead — schema mirrors the Postgres one.
2. **An api process** (`pukucloud-agent` — same binary as the data plane)
   configured with `PUKUCLOUD_DB_DSN=<dsn>`. This enables the
   `MultiNodeDirector` reverse-proxy in [`api/cmd/api/multinode.go`](../api/cmd/api/multinode.go).
3. **One or more agent hosts** that talk to the same Postgres. Each agent
   registers itself into the `agents` table on boot and heartbeats every
   10 s.

When `PUKUCLOUD_DB_DSN` is **unset** (the legacy path), the api talks to a
single local agent over a unix socket. When it is set, the api switches to
multi-node mode and the per-host agent + the agents behind the DSN become
indistinguishable from the caller's point of view — same `/v1/sandboxes`,
same `/v1/sandboxes/{id}/exec`, etc.

There is exactly **one** environment variable that flips the mode. Everything else
scales from there.

---

## The single switch: `PUKUCLOUD_DB_DSN`

```bash
# api / edge process
PUKUCLOUD_DB_DSN=postgres://app:secret@db.example.com:5432/pukucloud?sslmode=require
PUKUCLOUD_NODE_TOKEN=<replace-with-shared-secret>   # forwarded to agents
PUKUCLOUD_REGION=us-central1                       # preferred placement region
```

What the api does once the DSN is set:

| Concern | Behavior |
| --- | --- |
| Per-request routing | `MultiNodeDirector` looks up `sandbox → agent` via the `leases` table for `/v1/sandboxes/{id}/*`; otherwise asks `scheduler.Pick()` to choose an agent. |
| Per-request size | `Pick()` reads the request body to extract `cpu`/`memory_mb` (and `size_mb` for `/v1/volumes`) so the host capacity check is real, not stale. |
| Pool | Volume creates are forced to the `stateful` pool (host-pinned disk); otherwise the caller's `RequirePool` is honored. |
| Reverse proxy | `httputil.ReverseProxy` rewrites `/v1/*` → `/*` on the agent, sets `X-Forwarded-Agent`, strips `access_token`, and forwards `X-Node-Token`. |
| Lease cache | Edge caches `sandbox → agent` for 5 min after every Create/Delete so the very next request skips Postgres. Persistent sandboxes get a 1-hour cache. |
| Error shape | If no agent qualifies, returns `503 Service Unavailable` + `Retry-After: 5`, **not** 502 — "no compute capacity" is retryable. |
| PgBouncer DSU | If the DSN points at port 6543 / 5431 (Supabase pooler), the api appends `default_query_exec_mode=simple_protocol` so prepared statements don't break transaction pooling. |

If the DSN is unset, the api reverts to the unix-socket director used by
[`docker-compose.yml`](../docker-compose.yml). You can keep both modes in the
same binary — they are gated by `LoadMultiNodeConfig() == nil`.

---

## Agent registration and heartbeats

Every `pukucloud-agent` process self-registers into the `agents` table the
moment it boots. Code: [`agent/internal/registry/registry.go`](../agent/internal/registry/registry.go).

```sql
-- agents table (see agent/migrations/postgres/00008_multinode.sql)
id              TEXT PRIMARY KEY     -- short instance name, e.g. agent-7c3f
endpoint        TEXT                 -- e.g. https://agent-7c3f.internal:9090
zone            TEXT
status          TEXT                 -- 'active' | 'draining'
capacity_json   JSONB                -- live capacity on every heartbeat
last_heartbeat  TIMESTAMPTZ
```

What the agent writes on boot:

```go
r.WithIdentity(id, endpoint, region, zone, version).Register(ctx, cap)
```

What the api reads (see [`api/internal/scheduler/scheduler.go`](../api/internal/scheduler/scheduler.go)):

```sql
SELECT id, endpoint, region, zone, version, status, capacity_json, last_heartbeat
FROM agents
WHERE status = 'active' AND last_heartbeat > now() - interval '30 seconds'
```

Anything older than 30 s is dropped — agents stop receiving placements
within one heartbeat of going silent. They keep their row (`status='active'`
→ no row deletion on shutdown, only on explicit `Deregister()` which flips
to `'draining'`).

### What goes in `capacity_json`

Mirrored on both sides ([`agent/registry.go`](../agent/internal/registry/registry.go) and
[`api/scheduler.go`](../api/internal/scheduler/scheduler.go)):

| Field | Meaning |
| --- | --- |
| `cpu_total`, `cpu_used` | Logical cores and current guest vCPU burst total |
| `memory_mb_total`, `memory_mb_used` | Host RAM and what guests are holding |
| `sandboxes` | Live count |
| `load_average` | 1-min load |
| `stream_restore_enabled` | UFFD streaming is on → tiebreaker boost |
| `volume_provisioned_bytes` | Sum of apparent sizes of host-pinned volume `.ext4` files |
| `volumes_fs_size_bytes`, `volumes_fs_free_bytes` | The backing filesystem |
| `pool` | `"stateful"` or `"ephemeral"` (omitted → defaults to `stateful`) |

---

## Scheduler and lease table

Two pieces of shared state, two lifecycles:

### `agents` — who's alive

- Written by each agent on every heartbeat (every 10 s).
- Read by every api/edge process on every `Pick()`.
- Cached at the edge for 30 s (`scheduler.New(db, 30*time.Second)`).
- 30 s staleness threshold — any agent that hasn't heartbeated in 30 s is
  treated as offline and not placed onto.

### `leases` — who owns this sandbox

```sql
CREATE TABLE leases (
  sandbox_id   TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Written by the agent immediately after a Create succeeds. Read by the edge
to route `/v1/sandboxes/{id}/*` requests back to the right host without
scoring. Edge keeps an in-memory cache (5 min default, 1 hour for
persistent sandboxes) so the hot path skips Postgres.

### Scoring

`Pick()` (`api/internal/scheduler/scheduler.go`) walks every active agent and
scores:

```text
score = freeCPU*0.6 + freeMemGiB*0.3
if stream_restore: score += 5.0
```

For volume placement the formula switches to storage headroom:

```text
score = volumeHeadroomGiB + freeCPU * 0.01   # tiny CPU tiebreak
```

where `volumeHeadroom` is `min(oversubBudget − provisioned, fsFree − 20GiB reserve)`.

Pool filter (`RequirePool` on `Request`, defaults to *no filter* for creates,
*stateful* for volumes) restricts candidates before scoring.

---

## Pools: `stateful` vs `ephemeral`

PukuCloud splits agents into two pools:

| Pool | Holds durable state? | Can scale in? |
| --- | --- | --- |
| `stateful` | Yes — `pukucloud-volumes` PD, managed-DB PGDATA, host-pinned sparse ext4 images | No |
| `ephemeral` | No | Yes, at any time |

Default rule (`agentPool()`): if the agent doesn't report a pool, treat it
as **stateful**. This is deliberate — a host that pre-dates the split may
hold customer volumes, and treating it as ephemeral would let a scale-in
strand that data. Erring toward the safe direction (no scale-in) costs a
suboptimal placement; the reverse costs data.

Volume creates (`POST /v1/volumes`) **always** land on `stateful` — the
caller's `RequirePool` is ignored for that path. This is enforced inside
`Pick()`, not by the caller.

---

## Burst-spread and the 2026-08-22 incident

The naive scoring path (`score = freeCPU*0.6 + …`) has a known burst shape: with
identical agents, every parallel request reads the same capacity, picks the
same agent, and piles onto it. The fix lives at [`scheduler.go:201-318`](../api/internal/scheduler/scheduler.go).

Mechanism:

1. `Pick()` holds a single mutex (`resMu`) across scoring **and** selection **and** the reservation write.
2. After picking, it writes a reservation `{cpu, mem, disk, at: now}` keyed by agent id.
3. The next Pick in the burst subtracts outstanding reservations from `freeCPU` / `freeMem` before scoring.
4. Reservations expire after 15 s (`reservationTTL`). By then the agent's heartbeat has reported the placement back, so the DB already accounts for it; keeping the reservation would double-count.

Defaults that matter:

- `defaultReservedCPU = 8` — every first-party template bakes 8 vCPU as a burst ceiling, so unsized creates must assume that too. Missing the default turns the whole mechanism into a no-op for the most common call shape (no body).
- Memory is **not** defaulted — it's a hard admission gate, so guessing high there would turn bursts into spurious "no agents available" errors.

The replica test `TestIncident20260822Replica` runs the exact production
inputs and asserts the split. Output on a passing run:
`map[30ph:3 bddt:2]` — five creates spread 3/2 instead of 5/0/0/0/0.

---

## Adding a node

### On the new agent host

1. Provision with `/dev/kvm`, `/dev/net/tun`, and `CAP_NET_ADMIN` /
   `CAP_SYS_ADMIN` (the same shape as [`deploy/host.sh`](../deploy/host.sh) or
   the Terraform modules under [`infra/terraform/modules/`](../infra/terraform/modules/)).
2. Drop a Firecracker kernel + at least one template at
   `/var/lib/pukucloud/{kernels,templates}/`.
3. Start the agent with the **same Postgres DSN** as the rest of the
   fleet:

   ```bash
   PUKUCLOUD_AGENT_LISTEN=0.0.0.0:9090 \
   PUKUCLOUD_AGENT_TOKEN=$PUKUCLOUD_NODE_TOKEN \
   PUKUCLOUD_DATA_DIR=/var/lib/pukucloud \
   PUKUCLOUD_DB_DSN=postgres://app:secret@db.example.com:5432/pukucloud?sslmode=require \
   PUKUCLOUD_REGION=us-central1 \
   PUKUCLOUD_POOL=stateful \
   PUKUCLOUD_AGENT_ID=$(hostname -s) \
   pukucloud-agent
   ```

4. Confirm: hit `GET /v1/healthz` on the agent, then `SELECT * FROM agents
   ORDER BY last_heartbeat DESC` in Postgres — your row should appear
   within ~10 s with `status='active'`.

That's it. No api config change, no migration, no restart of any other
host. New creates will start landing on it as soon as it heartbeats and the
edge cache (30 s) refreshes.

### On an existing agent MIG

On GCP, set `AGENT_COUNT` (or just `terraform apply` with a new
`agent_count`). The MIG will spin up new instances from the same
`user-data-agent.sh.tftpl` (see
[`infra/terraform/envs/dev-aws/user-data-agent.sh.tftpl`](../infra/terraform/envs/dev-aws/user-data-agent.sh.tftpl));
each new VM registers itself the same way. Scale-down is a drain (see
below).

---

## Removing a node (drain)

There is **no** in-place eviction yet. The safe sequence:

1. Flip the row in Postgres: `UPDATE agents SET status='draining' WHERE id=…`.
   The edge stops placing new sandboxes on it within 30 s (cache TTL).
2. Wait until `SELECT count(*) FROM leases WHERE agent_id=…` is zero, or
   you've communicated a maintenance window to the owners.
3. For each remaining sandbox: either let it finish naturally (it will be
   reaped on lease expiry → 24 h by default), or call
   `DELETE /v1/sandboxes/{id}` from the **edge**, which forwards to the
   owning agent — the lease row is removed.
4. Stop the agent. `Deregister()` (called from the agent's shutdown path)
   also flips `status='draining'`, but only if your supervisor lets it run.

Drain vs delete: the `agents` row is kept after drain so the dashboard can
still show "this sandbox was on agent-X". To remove the row entirely,
issue `DELETE FROM agents WHERE id=…` after the leases are empty.

For managed databases, drain is **mandatory** before scale-in — the
`agent_id` column on `sandboxes` (added in migration
[`00017_sandbox_agent_id.sql`](../agent/migrations/postgres/00017_sandbox_agent_id.sql))
is how the agent's reap loop scopes itself to *its own* sandboxes and avoids
deleting a healthy peer sandbox during a rolling restart. Reap still kills
orphaned sandboxes on the local store.

---

## Failure handling

| Symptom | What happens |
| --- | --- |
| Agent stops heartbeating | After 30 s, edge drops it from placement. Existing leases continue to work until they expire. |
| Agent process restarted | On boot, the agent runs `SweepAgentZombies(agentID, liveIDs)` against its local store — sandboxes it has no local state for are marked `failed`. Healthy sandboxes (its own) are untouched. |
| Edge can't reach a chosen agent | `httputil.ReverseProxy.ErrorHandler` returns 502 + JSON. The agent's prior heartbeats and lease rows are not affected — the caller's retry hits a different agent. |
| Edge returns 503 | Means `Pick()` found no active agent with capacity. Callers should retry; the dashboard surfaces this as "no compute capacity". |
| Network partition between agent and Postgres | Agent heartbeats fail; row `last_heartbeat` stops updating; treated as offline within 30 s. Existing leases time out after their TTL. |
| Postgres outage | Edge can't read `agents` / `leases` → 503 with retryable semantics. Agents can't heartbeat → eventually marked offline. |

---

## Known gaps

These are documented in the code comments and worth knowing before you
operate at scale:

1. **`GET`/`DELETE /v1/volumes` may route to the wrong agent.** The director
   peeks the body for `POST /v1/volumes` and forces stateful placement; for
   list/delete it does a generic Pick and may hit an agent that doesn't
   hold the volume in question. Until a control-plane volume registry
   exists, the agent's own 507 gate stays authoritative for writes, and
   reads may need to be retried against each agent.
2. **Sandbox→agent migration is not supported.** When an agent dies and
   its leases expire, the sandbox is marked `failed`. There is no path to
   re-bind a lease to a healthy agent. Rebuild via fork/fork-tree is the
   current escape hatch.
3. **Workload-tier autoscale decision is local.** The `ephemeral` pool's
   `cputiers` controller (in the agent) decides when to scale based on
   local PSI/cpu pressure. A regional-scale controller that watches the
   edge's view of fleet load is still pending.
4. **`agents` rows are never garbage-collected.** `Deregister` flips status
   to `draining` but the row stays. Over many churn cycles the table
   grows. A nightly prune of `status='draining' AND last_heartbeat < now()
   - interval '7 days'` is recommended.

---

## Verifying it works locally

The repo ships a regression test that drives the actual `Pick()` path with
3 simulated agents and 20 concurrent creates:

```bash
cd api
go test -v -run TestMultiNodeSimulationBurst ./internal/scheduler/
# === RUN   TestMultiNodeSimulationBurst
#     multinode_sim_test.go:64:   agent-1: 7 placements
#     multinode_sim_test.go:64:   agent-2: 7 placements
#     multinode_sim_test.go:64:   agent-3: 6 placements
# --- PASS: TestMultiNodeSimulationBurst (0.00s)
```

The full scheduler suite (every multi-node scoring rule plus the
incident-replica test) passes in well under a second:

```bash
go test ./internal/scheduler/
# ok  	github.com/pukucloud/api/internal/scheduler	0.006s
```

For an end-to-end smoke against real Postgres and two agents, see
[`deploy/deploy-gcp-multi.sh`](../deploy/deploy-gcp-multi.sh) (`up` then
`smoke`). The smoke script exercises `api.$CLOUDFLARE_DOMAIN` against the
real fleet.

---

## See also

- [architecture.md § Multi-node topology](architecture.md#multi-node-topology)
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — multi-node with the Workers control plane
- [setup-self-host-gcp.md](setup-self-host-gcp.md) and [setup-self-host-aws.md](setup-self-host-aws.md) — Terraform envs that produce multi-node fleets
- [secrets-and-config.md](secrets-and-config.md) — every `PUKUCLOUD_*` env var
- [disaster-recovery.md](disaster-recovery.md) — what to do when an agent or zone dies
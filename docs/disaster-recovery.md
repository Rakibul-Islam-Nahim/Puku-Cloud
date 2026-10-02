# Disaster recovery

The runbook for "something broke and I need to recover without losing customer data." Pairs with [observability.md](observability.md) (how to detect breakage) and [architecture.md](architecture.md) (where the data lives).

## Contents

- [Posture](#posture)
- [Failure-mode matrix](#failure-mode-matrix)
- [Managed-Postgres failover](#managed-postgres-failover)
- [Sandbox host loss](#sandbox-host-loss)
- [Control-plane loss](#control-plane-loss)
- [Temporal loss](#temporal-loss)
- [Sentry loss](#sentry-loss)
- [Secret rotation](#secret-rotation)
- [Rollback](#rollback)
- [Object-store loss](#object-store-loss)

---

## Posture

| | Durable | Reconstructable |
|---|---|---|
| Managed-Postgres PGDATA | Host-pinned to the agent's data volume + WAL archive (R2 / object store) | From base backup + WAL replay, onto a healthy host |
| Sandbox history (status, IDs, metadata) | D1 `sandboxes` + D1 `audit_log` | None — D1 is the source of truth |
| Per-agent live state | D1 `worker_manifest` (index) + `WorkerStateDO` (live) | Recreated on next agent heartbeat |
| Snapshot store | R2 bucket (cross-region replication lives there on Cloudflare) | From per-host caches, slowly |
| Template preseeds | R2 bucket + per-host local cache | Rebake via `scripts/bake-templates.sh` |
| Workflow history | Temporal server (its own Postgres) | None — Temporal is the source of truth |
| Errors + traces | Sentry (its own Postgres) | None beyond Sentry's own retention |

The asymmetry: **managed Postgres is the only line where loss is a customer-data event**. Everything else is compute, observability, or history that can be rebuilt.

---

## Failure-mode matrix

| What broke | Customer-visible? | What to do |
|---|---|---|
| One agent host | Some creates fail or land on the other agent; sandboxes on the dead host are gone | Drain, let Temporal re-route, replace the host |
| All agent hosts | All creates / wakes fail | Bring up new agents (the controller and Temporal are unchanged) |
| Managed-Postgres host | One database down | Restore-to-latest failover onto a healthy agent host |
| Controller (Cloudflare Worker) | All API calls fail | Workers failover transparently — Cloudflare routes around regional failure |
| Temporal | Activities stop being scheduled; new creates time out | See [temporal-failover.md](runbooks/temporal-failover.md) |
| Sentry | Errors not captured; nothing customer-facing breaks | Bring Sentry back; missed events are lost |
| R2 bucket | Cold-boots fall back to per-host caches (slow); UFFD/NBD page faults fail | Restore bucket; per-host caches are still valid until evicted |
| D1 | D1 has Cloudflare PITR (7-day); all controller calls fail | Restore from PITR (Cloudflare support) |
| Secret compromise | Risk of impersonation | Rotate + rolling-restart every consumer |

---

## Managed-Postgres failover

Managed-Postgres databases run inside a Firecracker microVM with a host-pinned data volume. The host-pinning is intentional — the agent pre-seeds the volume and the per-host kernel module for the data volume is part of boot time. To move a database to another host, the agent runs a **restore-to-latest failover**:

1. **Detect host loss** — agent heartbeat drops; the controller marks the host `offline` in `WorkerStateDO` and stops scheduling work there.
2. **Pick a healthy target** — Temporal's task-queue router picks the next available agent.
3. **Pull latest base backup + WAL** — the target agent downloads the latest base from R2 and replays WAL from the relay up to the last archived segment.
4. **Update lease** — controller flips the lease to the new agent's `PUKUCLOUD_WORKER_ID`; subsequent queries go there.
5. **Cut DNS** — the per-database Postgres `host=<id>.db.<zone>` record is updated.

The whole process is in `agent/internal/sandbox/db_restore.go`. Operator-visible triggers:

```bash
# Trigger a manual failover (e.g. you know a host is dying soon)
pukucloud databases failover <database_id> --reason "host imminent"

# Force a failover even if the source looks alive
pukucloud databases failover <database_id> --reason "host-drain" --force
```

RPO is bounded by the WAL archive cadence (default: continuous, max 60 s lag). RTO is base-backup download + WAL replay — typically 30 s to 5 min depending on write volume and WAL retention.

### WAL archive gaps

`pukucloud-wal-archive.sh` exits 1 when the relay is unreachable so postgres retains the segment and retries. To recover from a real gap:

1. Identify the gap: `pukucloud wal-gaps <database_id>` lists missing segments in the archive timeline.
2. If the missing segments are still on the source host's data volume (host not yet garbage-collected), copy them directly via the agent.
3. If the source host is gone, the gap is permanent — promote the next base backup and start from there.

The `wal.env` delivery grace window (15 minutes) prevents an early-boot false-positive: if `wal.env` has not landed, segments are retained, not recycled.

---

## Sandbox host loss

A sandbox's lifecycle is bound to its host. If the host dies, the sandbox is gone. Customers see their `sbx_*` ID return `404` after the reaper sweep.

Operator flow:

1. **Mark the host `draining` in the DO.** The controller stops placing new sandboxes there; running sandboxes are unaffected until they exit. See [agent-evacuation.md](runbooks/agent-evacuation.md) for the full procedure.
2. **Wait for the reaper** (`PUKUCLOUD_REAPER_INTERVAL_SECONDS`, default 30 s) to sweep orphaned leases.
3. **Replace the host.** On AWS, attach the old data volume to the new instance (`aws ec2 attach-volume`); user-data mounts by label and never reformats an existing filesystem. On GCP, the MIG auto-heal creates a new instance and re-attaches the stateful disk automatically. On bare metal, see the operator's IaC of choice.
4. **Re-bake templates.** A new host cold-bakes the template preseed on first use; enable `PUKUCLOUD_SNAPSHOT_PREFETCH=1` to warm the cache ahead of time.

`PUKUCLOUD_DATA_DIR=/var/lib/pukucloud` is per-host. Wipe it for a true cold start (`sudo rm -rf /var/lib/pukucloud/*`), but only do this when you intend to re-bake every template.

---

## Control-plane loss

The control plane is the Cloudflare Worker. Workers are inherently multi-region. A regional outage degrades the API but does not take it down — Cloudflare's edge routes around the failure. Customers see elevated 5xx rates for the duration of the regional outage.

No operator action; monitor the Cloudflare status page and your `wrangler tail` for the affected region. If you need to roll back to a previous version, see [Rollback](#rollback).

---

## Temporal loss

See [runbooks/temporal-failover.md](runbooks/temporal-failover.md) for the full procedure. Summary: the controller's `StartWorkflow` calls time out; agents poll no new activities; running activities either complete or hit the heartbeat timeout (60 s default) and Temporal re-routes them. Recovery is to bring Temporal back up — workflow state is durable in Temporal's own Postgres.

There is no legacy "agent-direct proxy" fallback any more. If Temporal is down long enough that customer creates time out, communicate the outage; do not start agents in a degraded mode that bypasses Temporal.

---

## Sentry loss

Errors stop being captured. Nothing customer-facing breaks. Restore the Sentry container:

```bash
cd infra/sentry
docker compose up -d
```

Missed events are lost (Sentry's HTTP envelope is fire-and-forget). When Sentry is back, look at the controller's `wrangler tail` for any errors that happened during the outage.

---

## Secret rotation

Every secret has a single owner and a single rotation procedure:

| Secret | Where | Rotation |
|---|---|---|
| `SENTRY_SECRET_KEY` | `infra/sentry/docker-compose.yml` (3 places) | Edit the compose file; `docker compose restart sentry-web sentry-worker sentry-cron`. |
| `TEMPORAL_AUTH_TOKEN` | Workers secret + Temporal env | `wrangler secret put TEMPORAL_AUTH_TOKEN` (next Worker deploy reads it). |
| `PUKUCLOUD_AGENT_TOKEN` | Workers secret + agent env | `wrangler secret put PUKUCLOUD_AGENT_TOKEN`; then update `/etc/pukucloud/agent.env` on every agent host and `systemctl restart pukucloud-agent`. **Out-of-sync agent tokens are the most common cause of "agent looks healthy but heartbeats fail".** |
| `PUKUCLOUD_ADMIN_TOKEN` | Workers secret | `wrangler secret put PUKUCLOUD_ADMIN_TOKEN`. The next Worker deploy reads it. |
| `SUPABASE_JWKS_URL` (and `_ISSUER`, `_AUDIENCE`) | Workers secret | JWKS is fetched live; rolling restart not strictly required. |

Workers read secrets at deploy time. The next `wrangler deploy` after a `secret put` is what activates the new value.

Agent processes read `agent.env` once at boot. A secret change on the agent requires a `systemctl restart pukucloud-agent` on every host.

---

## Rollback

### Controller (Workers)

1. Identify the bad deploy: `wrangler deployments list --env production` shows timestamps and traffic.
2. Roll back: `wrangler rollback --env production`. This is instantaneous and Cloudflare keeps the previous version warm.
3. Verify: `wrangler tail --env production`, watch for the error signature you saw before the rollback.

### Agent binary

The agent is forward-compatible with the controller as long as the Temporal activity and workflow names line up. To roll back:

```bash
# On each host:
sudo systemctl stop pukucloud-agent
sudo cp /var/lib/pukucloud/agent.prev /usr/local/bin/agent
sudo systemctl start pukucloud-agent
```

In-flight activities finish on the new (older) binary once the worker re-subscribes (~30 s).

### Temporal

Don't roll back Temporal across a workflow-definition change. The Temporal client SDKs are version-sensitive. If you must, do it during a quiet window and accept that any in-flight workflow of the newer type will fail.

---

## Object-store loss

The R2 bucket holds:

- Template preseeds (`templates/<name>/rootfs.ext4`).
- UFFD memory pages and NBD rootfs chunks.
- Managed-Postgres WAL archive and base backups.
- Cross-host sandbox fork snapshots (if enabled).

If the bucket is lost:

1. **Template preseeds** — every host re-bakes from scratch on next use (slow). `scripts/bake-templates.sh` from this repo.
2. **UFFD/NBD** — pages fall back to the local chunk cache on each host, then fail when the cache evicts. Re-uploading the bucket is the only fix; for the duration, cold-boots get slower.
3. **WAL archive** — every active database that has not yet taken a new base backup is at risk. The agent falls back to local WAL retention on the data volume for as long as space holds; `pukucloud-wal-archive.sh` retains and retries.
4. **Fork snapshots** — sandbox forks become invalid; the parent sandbox itself is unaffected.

If the bucket was deleted, restore from the bucket's own replication (Cloudflare R2 supports cross-region replication) or from a snapshot taken at the storage layer. If both are gone, this is a data incident — see the playbook in your incident-response plan.

---

## See also

- [architecture.md](architecture.md) — where the data lives.
- [observability.md](observability.md) — how to detect breakage.
- [secrets-and-config.md](secrets-and-config.md) — secret rotation procedure.
- [runbooks/temporal-failover.md](runbooks/temporal-failover.md) — Temporal-specific runbook.
- [runbooks/agent-evacuation.md](runbooks/agent-evacuation.md) — drain a single agent.
- [runbooks/region-loss.md](runbooks/region-loss.md) — full regional incident.
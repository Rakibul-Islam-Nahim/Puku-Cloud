# Architecture

How PukuCloud fits together: the control plane, the data plane, and the workload microVMs. This is the single source of truth for the architecture; setup guides, runbooks, and subsystem docs all link back here.

## Contents

- [Three layers](#three-layers)
- [Control plane](#control-plane)
- [Data plane](#data-plane)
- [Workload microVMs](#workload-microvms)
- [Snapshot pipeline](#snapshot-pipeline)
- [UFFD memory streaming](#uffd-memory-streaming)
- [Demand-paged rootfs](#demand-paged-rootfs)
- [Scheduler](#scheduler)
- [Multi-node topology](#multi-node-topology)
- [Auth boundaries](#auth-boundaries)
- [Where each layer lives in this repo](#where-each-layer-lives-in-this-repo)

---

## Three layers

PukuCloud is split along a clean control-plane / data-plane boundary. The control plane decides; the data plane executes. Workloads live one layer further down, isolated inside Firecracker microVMs.

```text
+-------------------------------------------------------------------+
|                       CONTROL PLANE                                |
|  - REST API, auth, tokens, orgs                                   |
|  - Template catalog, snapshot registry, DB catalog                |
|  - Scheduler (capacity scoring, leases)                           |
|                                                                   |
|  Implementations:                                                 |
|    * Self-hosted Go API   (api/)                                  |
|    * Cloudflare Workers   (workers/ — production target)          |
+-------------------------------------------------------------------+
                              |
                              |  (one HTTPS hop per /v1/* request)
                              v
+-------------------------------------------------------------------+
|                       DATA PLANE                                  |
|  - One Firecracker agent per KVM host                             |
|  - Boots and tears down microVMs                                  |
|  - Hosts the snapshot store, UFFD/NBD streamers                   |
|  - Reads audit/event/metrics writes back to ClickHouse            |
+-------------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------------+
|                   WORKLOAD MICROVMS                               |
|  - Firecracker microVMs restored from per-template snapshots      |
|  - Sandboxes for AI agents / untrusted code                       |
|  - Managed-Postgres databases (one DB per microVM)                |
|  - Volumes attach as virtio-blk devices                           |
+-------------------------------------------------------------------+
```

The control plane never touches guest memory or disks directly — it only talks to agents over HTTPS, and the agents do the actual Firecracker work.

---

## Control plane

**Responsibilities:**

- Accept sandbox and database requests over REST (`/v1/sandboxes`, `/v1/databases`).
- Authenticate callers (`pds_*` tokens, JWTs, or stub mode).
- Pick a host: the scheduler scores agents by capacity, leases, and template readiness, then returns a target.
- Track the catalog: which templates exist, which snapshots are named, which databases are alive, which org owns what.
- Surface audit and metrics.

**Two implementations exist today** and they share the same REST surface so callers don't care which is deployed:

| Implementation | Path | When to use |
| --- | --- | --- |
| Self-hosted Go API | [`api/`](../api) | Single-region, on-prem, no CF account. Runs as one or more Linux processes behind your TLS terminator. |
| Cloudflare Workers | [`workers/`](../workers) | Production target. Workers + D1 + R2 + KV; agents anywhere reachable from the CF edge. |

Both store control-plane state in Postgres (Go API) or D1 (Workers) and emit events to ClickHouse. See [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) for the Workers setup walkthrough, and [setup-self-host-aws.md](setup-self-host-aws.md) / [setup-self-host-gcp.md](setup-self-host-gcp.md) for self-hosted.

---

## Data plane

**One Firecracker agent per KVM host.** The agent is a single Go binary (`agent/`) that:

1. Reads its template seeds + memory snapshots from object storage (GCS or R2) into a local content-addressed chunk cache.
2. Receives `/v1/sandboxes/{id}/exec|filesystem|…` from the control plane and translates them into Firecracker API calls (`InstanceStart`, `PutGuestEvents`, …).
3. Hosts the userfaultfd pager and the in-kernel NBD server that stream memory and rootfs lazily into running guests.
4. Writes sandbox events and per-sandbox metrics to ClickHouse.
5. Heartbeats to the scheduler and reconciles slot leases.

**Why one agent per host?** Firecracker needs nested virtualization or bare-metal `/dev/kvm`. There's no shared-nothing multi-tenancy inside a single agent process: each VM has its own kernel, its own tap device, its own network namespace, and its own slot. So the unit of scale is "agent host", and the scheduler treats each agent as an opaque capacity bucket.

---

## Workload microVMs

Two flavors, both backed by the same template + snapshot pipeline:

### Sandboxes
- Created from a template (`base`, `code-interpreter`, `agent`, or a user-built template).
- Disk = the template's baked rootfs; memory = the template's snapshot.
- Lifecycle: `create → exec/REPL/LSP/terminal → pause/resume → snapshot/fork → hibernate/wake → delete`.
- TTL-based expiry and an idle reaper handle cleanup.

### Managed Postgres
- Created with `POST /v1/databases`; one microVM per database.
- Inside the VM: PostgreSQL 16 + PgBouncer + a query-broker that proxies `postgres://` traffic over a vsock tunnel back to the agent (and out through `db-proxy` to the public `*.db.<zone>` SNI host).
- Continuous WAL archiving; on failure the agent restores onto a peer and the API flips the database's state to `ready` once the new VM accepts connections.

---

## Snapshot pipeline

Every create restores a baked per-template snapshot. The pipeline is the same for sandboxes and databases:

```text
templates/<name>/Dockerfile
        │  pukucloud-agent seed-sync on agent boot
        ▼
gcs://<bucket>/templates/<name>/rootfs.ext4   (or r2://)
        │  + memory snapshot (vm.mem + vmstate)
        ▼
local chunk cache on the agent (content-addressed)
        │  InstanceStart with --snapshot
        ▼
microVM boots in ~150 ms (cold host) or <50 ms (warm host)
```

Template authoring: see [bake-global-templates.md](bake-global-templates.md). Per-template baking (`pukucloud template build`) is a separate path that lets users turn their own Dockerfile into a template.

---

## UFFD memory streaming

Cold hosts don't have to download the full memory snapshot. The agent:

1. Starts the VM with a sparse memory file (the snapshot's `vmstate` + `vm.mem`).
2. Runs a `userfaultfd` pager that handles missing pages by issuing a Range GET against object storage.
3. Pages are cached locally in the chunk cache; subsequent faults hit cache.

Effect: a create on a cold host boots in ~150 ms; a warm host (recent same-template restore) is sub-50 ms. The cost is that the first fault on each new page blocks guest execution until the range returns — typically a few ms.

---

## Demand-paged rootfs

Same idea, applied to disk. Instead of mounting the full `rootfs.ext4` read-only, the agent:

1. Creates an in-kernel NBD device backed by a small in-memory stub.
2. Wires `nbd` to a Go service that, on each read, issues a Range GET for the corresponding chunk of the rootfs.
3. The guest kernel's page cache fills in on demand; reads beyond what's been touched never reach the host.

Net effect: a cold agent can boot any template without first downloading the entire rootfs.

---

## Scheduler

The scheduler lives in the control plane (Go: `api/internal/scheduler/`, Workers: a thin shim in front of D1 + a stable-hash agent pick). It does three things:

1. **Heartbeats.** Agents register their capacity (CPU, RAM, disk), and the scheduler stores lease state.
2. **Scoring.** On a create request, the scheduler filters out hosts that are unhealthy, full, or missing the requested template's seed, then scores the rest by capacity headroom.
3. **Leases.** When a host picks a sandbox to boot, it holds a short lease; if the lease expires (network partition, host death), the sandbox is reaped and the next create can land there.

The Go API ships a full implementation; the Workers deployment uses a simpler stable-hash agent pick — adequate while you have a small fleet, not adequate for hundreds of agents. See the `internal/scheduler/` package and the audit in [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) for the production-grade gap list.

---

## Multi-node topology

A typical self-hosted AWS or GCP fleet looks like:

```text
                            internet
                                |
                                v
                          Cloudflare proxy
                                |
                                v
                       edge ASG / MIG  (TLS, API)
                          /         \
                         v           v
                   RDS / Cloud SQL  ClickHouse VM
                   (audit, tokens,  (events, metrics,
                    templates)       boots)
                                ^
                                |
                                v  (heartbeat, leases)
                +-------------------------------+
                |                               |
                v                               v
         agent host 1                   agent host 2
         (c5n.metal / n2-std)           (c5n.metal / n2-std)
         - Firecracker                  - Firecracker
         - chunk cache                  - chunk cache
         - UFFD / NBD                   - UFFD / NBD
         - WAL archive                  - WAL failover target
                \                               /
                 \                             /
                  v                           v
                  +--- db-proxy (SNI 5432) ---+
                          \                 /
                           v               v
                       *.db.<zone>     dashboard.<zone>
                       (TLS Postgres)  (Cloudflare Pages)
```

Concrete numbers (instance sizes, costs, caveats) live in [infra/README.md](../infra/README.md). The Cloudflare Workers deployment shrinks the control plane to "just the edge" and lets you keep the same agent fleet — see [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md).

---

## Auth boundaries

Three trust boundaries are enforced by the control plane:

| Boundary | Token / header | Where it's checked |
| --- | --- | --- |
| Caller → control plane | `pds_*` API token or JWT (`Authorization: Bearer …`) | Control-plane auth middleware (`api/internal/auth`, `workers/src/middleware/auth.ts`) |
| Control plane → agent | `PUKUCLOUD_AGENT_TOKEN` (shared bearer) + `X-Node-Token` for node-to-node | Agent HTTP handler (`agent/internal/api`) |
| Agent → guest (db-proxy tunnel) | `pds_pg_*` Postgres token (in-VM) | query-broker inside the guest, validated against the parent DB catalog |

The Workers control plane forwards the user's `pds_*` token **and** the shared agent token in the same `Authorization` header — the agent strips the user's token and trusts the agent token. See [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) for the exact wire format and the open gaps.

---

## Where each layer lives in this repo

| Layer | Path | Owns |
| --- | --- | --- |
| Control plane (Go) | [`api/`](../api) | REST handlers, scheduler, multi-node state in Postgres, audit, OpenAPI. |
| Control plane (Workers) | [`workers/`](../workers) | TypeScript + Hono, D1 + R2 + KV bindings, agent reverse-proxy. |
| Data plane | [`agent/`](../agent) | Firecracker SDK, slotstore, snapstore, memstream (UFFD), diskstream (NBD), templates, OCI registry. |
| Postgres tunnel | [`db-proxy/`](../db-proxy) + [`templates/postgres-16/query-broker/`](../templates/postgres-16) | SNI proxy + in-VM query broker. |
| Templates | [`templates/`](../templates) | First-party `base` / `code-interpreter` / `agent` / `postgres-16` Dockerfiles. |
| Deployment | [`infra/`](../infra), [`deploy/`](../deploy), [`cloud-init/`](../cloud-init), [`ansible/`](../ansible) | Terraform envs, rolling update runbook, host provisioning. |
| Dashboard | [`dashboard/`](../dashboard) | Next.js UI; deployed to `app.<zone>` on Cloudflare Pages. |
| CLI | [`cmd/pukucloud/`](../cmd/pukucloud) | Stdlib-only Go CLI for sandboxes, templates, tokens. |
| Docs | [`docs/`](../docs), [`docs-site/`](../docs-site) | GitHub-rendered (this folder) and Next.js docs site. |

For per-directory ownership and reading order, see [repo-layout.md](repo-layout.md).

---

## See also

- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md)
- [setup-self-host-aws.md](setup-self-host-aws.md)
- [setup-self-host-gcp.md](setup-self-host-gcp.md)
- [disaster-recovery.md](disaster-recovery.md)
- [observability.md](observability.md)
- [repo-layout.md](repo-layout.md)
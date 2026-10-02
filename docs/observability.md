# Observability

Where PukuCloud's logs, errors, traces, and event history live — and how the dashboard reads them back. For the secret/env wiring, see [secrets-and-config.md](secrets-and-config.md). For the topology, see [architecture.md](architecture.md).

## Contents

- [Signal model](#signal-model)
- [Where signals are produced](#where-signals-are-produced)
- [Where signals are read](#where-signals-are-read)
- [Logs](#logs)
- [Tracing](#tracing)
- [Operating tips](#operating-tips)

---

## Signal model

Four signal types, four storage paths:

| Signal | Storage | Producer | Reader | Retention |
|---|---|---|---|---|
| Action history (state changes) | D1 `audit_log` | Controller | Dashboard `/audit` | D1-retained |
| Per-agent live state | Cloudflare Durable Object (`WorkerStateDO`) | Agent (heartbeat) → Controller (`/v1/workers`) | Dashboard `/workers` | While DOs live; survives CF eviction only via D1 manifest |
| Workflow history (long-running ops) | Temporal server (Postgres-backed) | Agent activities | Temporal UI + `wrangler tail` | Permanent until retention sweeps |
| Errors + traces | Sentry | Controller + Agent SDKs | Sentry UI | Per-project retention |
| Operational logs | journald (host), `wrangler tail` (edge) | All processes | `journalctl`, `wrangler tail` | Disk-bounded |

There is no ClickHouse in this project. Time-series analytics were retired in Phase 4 of the migration to D1 + DO. Customer-visible observability lives on the dashboard's **Workers** and **Audit Log** pages; operator-visible observability lives in Temporal and Sentry.

---

## Where signals are produced

### Action audit (`audit_log` table in D1)

Every state-changing request from the controller writes one row. Schema (defined in `workers/migrations/`):

| Column | Source |
|---|---|
| `ts` | Server clock. |
| `actor` | Caller identity (org + user id). |
| `action` | e.g. `sandbox.create`, `sandbox.delete`, `database.failover`, `template.build`. |
| `workflow_id` | Temporal workflow id (for actions that start a workflow). |
| `details_json` | Action-specific context (id, status, error). |

Writes are best-effort: failures are logged but do not block the response. The sink is `workers/src/services/clickhouse.ts` (which is actually a `D1AnalyticsSink` writing to `audit_log`; the filename is a historical artifact).

### Agent live state (`WorkerStateDO`)

Every 10 s, each agent POSTs its live state to `POST /v1/internal/agents/:worker_id/state`. The controller:

1. Authenticates via shared `PUKUCLOUD_AGENT_TOKEN`.
2. Upserts a row into D1 `worker_manifest` (the index).
3. Writes the live state into the corresponding `WorkerStateDO` instance.

See [architecture.md](architecture.md#workerstatedo-live-agent-state) for the full DO schema.

### Temporal workflow history

Every workflow execution — `LaunchMicroVMWorkflow`, `PauseMicroVMWorkflow`, `ResumeMicroVMWorkflow`, `SnapshotMicroVMWorkflow`, `Database*Workflow` — is recorded with full activity history, retries, and heartbeats. Open the Temporal UI (`http://temporal.your-domain.tld:8080` in production, `http://localhost:8080` in dev with the `ui` profile) to inspect any execution by id.

### Sentry

Two projects:

| Project | Language | What it captures |
|---|---|---|
| `pukucloud-controller` | Node | Request-path errors, latency transactions, slow DB queries, Sentry traces. |
| `pukucloud-agent` | Go | Agent crashes, Firecracker API failures, UFFD/NBD errors, Temporal worker disconnects. |

The DSN for each is set as a `wrangler secret` (controller) or as `SENTRY_DSN` on the agent host. Configure your alert rules to page on:

- New error in `pukucloud-controller` (5xx rate spike).
- `pukucloud-agent` Firecracker error rate > 1 / minute.
- Temporal activity heartbeat timeout (caught in both projects).

---

## Where signals are read

| What | Where |
|---|---|
| Per-agent status, capacity, last-seen | Dashboard `/workers` — polls `GET /v1/workers` every 5 s. |
| Action history | Dashboard `/audit` — reads D1 `audit_log`. |
| Workflow execution history | Temporal UI (`http://temporal.<zone>:8080`). |
| Errors + traces | Sentry UI (`http://sentry.<zone>:9000`). |
| Worker logs | `wrangler tail` (CF controller) / `journalctl -u pukucloud-agent` (agent hosts). |

### `/v1/workers` response shape

```json
{
  "workers": [
    {
      "worker_id": "host-1",
      "region": "us-east-1",
      "status": "busy",
      "current_vm_id": "vm_01HXY...",
      "capacity": { "cpu_total": 72, "cpu_used": 18, "mem_total_mb": 196608, "mem_used_mb": 49152 },
      "last_seen": "2026-10-02T14:23:01Z",
      "workflow_count": 3,
      "version": "0.4.2"
    }
  ]
}
```

A worker with `status: "offline"` has not heartbeated in > 30 s. Investigate via Sentry + the agent's `journalctl` log first.

---

## Logs

| Component | Where |
|---|---|
| Controller (Cloudflare Worker) | `wrangler tail --env production` |
| Agent | `journalctl -u pukucloud-agent -f` (systemd), structured JSON to stdout. |
| In-VM daemon (`pukucloud-daemon`) | Serial console (Firecracker captures to host log). |
| In-VM Postgres | `journalctl` inside the VM, plus `pukucloud-wal-archive.sh` system-log lines tagged with `pukucloud-wal-archive`. |
| Temporal | `docker compose -f infra/temporal/docker-compose.yml logs temporal` (self-hosted). |
| Sentry | Sentry UI (errors) — workers symtab; Docker log (events). |

The dashboard does not surface log search; operators tail logs directly. Logs are intentionally separate from Sentry because they are much higher volume and not useful for tracing.

---

## Tracing

Sentry captures request-path traces via its Node SDK (controller) and Go SDK (agent). The two are **not** correlated — there is no trace-id propagation across the Temporal hop yet. A future improvement is to mint a request-id in the controller, put it on the Temporal header, and have the agent attach it as a Sentry tag. For now, the way to follow a single request across systems is:

1. Note the `X-Request-Id` header (or the value of `requestId` in any log line) from the controller.
2. Grep `wrangler tail` for it on the controller side, and grep `journalctl` for it on the agent side (the controller propagates the id into the workflow input).

---

## Operating tips

- **Workers page shows 0 agents.** Either the agents have not been started, or they cannot reach the controller. Verify: `curl https://api.<zone>/v1/internal/agents` (with `PUKUCLOUD_AGENT_TOKEN`) returns the configured `PUKUCLOUD_AGENT_URLS`; check `journalctl -u pukucloud-agent` on the agent host for heartbeat errors.
- **Agent shows `offline`.** Last heartbeat > 30 s ago. Look at Sentry for the agent's process exit or network errors. The controller's `/v1/workers` reflects state within one heartbeat window.
- **Sentry bucket is empty.** Confirm the DSN is set (`wrangler secret list | grep SENTRY_DSN` for the controller, `env | grep SENTRY_DSN` on the agent host). Sentry's `Event` ingest takes ~5 s.
- **Temporal activity is stuck.** Open the Temporal UI, find the workflow by id, look at the failing activity's stack trace. The activity will be retried automatically based on its `RetryPolicy` (default: exponential backoff up to `StartToCloseTimeout`).
- **`audit_log` is huge.** D1 rows are append-only. If you need to archive, schedule a Worker cron that copies rows older than N days to a R2 bucket and deletes them. Not implemented yet.

---

## See also

- [architecture.md](architecture.md) — where each component writes from.
- [secrets-and-config.md](secrets-and-config.md) — `SENTRY_DSN`, `TEMPORAL_ADDRESS`, `PUKUCLOUD_AGENT_TOKEN`.
- [setup-temporal-self-host.md](setup-temporal-self-host.md) — bring up Temporal + Sentry locally.
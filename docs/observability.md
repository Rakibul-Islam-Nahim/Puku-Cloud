# Observability

Where PukuCloud's logs, metrics, and events live, how they get there, and how the dashboard reads them back. For the secret/env wiring, see [secrets-and-config.md](secrets-and-config.md). For the topology, see [architecture.md](architecture.md).

## Contents

- [Signal model](#signal-model)
- [ClickHouse: events, requests, metrics](#clickhouse-events-requests-metrics)
- [How signals are produced](#how-signals-are-produced)
- [How signals are read](#how-signals-are-read)
- [Dashboard reads](#dashboard-reads)
- [Self-hosted ClickHouse vs ClickHouse Cloud](#self-hosted-clickhouse-vs-clickhouse-cloud)
- [Logs](#logs)
- [Metrics endpoints](#metrics-endpoints)
- [Tracing](#tracing)
- [Operating tips](#operating-tips)

---

## Signal model

Three signal types, three storage paths:

| Signal | Storage | Producer | Reader | Retention |
| --- | --- | --- | --- | --- |
| Per-request HTTP access rows | ClickHouse `pukucloud.http_requests` | API middleware (`mwClickHouseLog`) | Dashboard `/v1/metrics/overview` | Time-based, see disk sizing |
| Sandbox boot/creation events | ClickHouse `pukucloud.boot_events` | Agent + control plane | Dashboard `/v1/metrics/overview` | Time-based |
| Sandbox runtime metrics (CPU%, mem) | ClickHouse `pukucloud.sandbox_metrics` | Agent | Dashboard `/v1/metrics/sandbox/:id` | Time-based |
| Operational logs | journald (host), Worker tail logs (Cloudflare) | All processes | `journalctl`, `wrangler tail` | Disk-bounded |
| Prometheus metrics | Agent `:9100/metrics`, API `:8080/metrics` | Prometheus client_golang | Prometheus scrape | Per-scrape |

The control plane treats analytics as **best-effort**. With Phase 4 (ClickHouse removal), time-series analytics are deferred; state-changing actions still land in the D1 `audit_log` table and per-worker live state lives in the WorkerStateDO. Operators see the dashboard's audit + workers pages for current visibility.

---

## ClickHouse: events, requests, metrics

The single source of truth for everything dashboard-visible. Schema is bootstrapped idempotently on API start (`clickhouse.EnsureSchema`).

### Tables

| Table | Row shape | Cardinality control |
| --- | --- | --- |
| `pukucloud.http_requests` | `(ts, workspace_id, request_id, method, route, status, duration_ms, actor_id, ip, user_agent)` | `route` is normalized via `normalizeRoute` — path-segment IDs collapse to `:id` so `GET /v1/sandboxes/abc123` and `GET /v1/sandboxes/xyz789` share one row key |
| D1 `audit_log` (Workers) | `(ts, org_id, actor, action, workflow_id, details_json)` | One row per state-changing action. Workers side; written by the controller via the D1 sink (`workers/src/services/clickhouse.ts`). |

### ClickHouse: retired

The previous ClickHouse-backed time-series analytics were retired in Phase 4.
For per-agent live state (status, last-seen, capacity), see the dashboard's
**Workers** page — it reads the controller's `WorkerStateDO`. For action
history, see the **Audit log** page — it reads `audit_log`.

---

## How signals are produced

### API (control plane)

- `mwClickHouseLog` wraps every request, fires after downstream middleware (so `workspace_id` and `actor_id` are already populated).
- Skips `/healthz`, `/version`, `/metrics` to keep the noise floor low.
- Redacts passwords in logged URLs (`redactPassword`).
- Best-effort: insert failures are logged, not surfaced. The middleware never blocks a response.

### Agent

- Boots emit a row to `boot_events` with the restore mode.
- A periodic sampler writes `sandbox_metrics` for every running sandbox. Frequency is tuned to keep the disk from filling while still giving the dashboard useful resolution.
- On AWS / GCP / local dev, the agent's ClickHouse URL points at the control-plane ClickHouse (the one the API also writes to).

### Workers (Cloudflare control plane)

- `workers/src/services/clickhouse.ts` implements a singleton sink per isolate.
- Pushes are batched to 256 rows or 5 s, whichever first. The Workers runtime has no long-lived process, so flush-on-teardown is best-effort.
- Format is the same `JSONEachRow` over HTTPS to ClickHouse Cloud.
- Disabled (no-op) when `CLICKHOUSE_URL` is unset — same "best-effort" stance as the Go API.

---

## How signals are read

Two read paths, both implemented as a thin layer on top of ClickHouse HTTP.

### `/v1/metrics/overview`

Returns eight time series in one round-trip:

| Series | Source query |
| --- | --- |
| `http_rps` | `count()` over `http_requests` per bucket |
| `http_p50` / `http_p95` | `quantile(0.50)` / `quantile(0.95)` of `duration_ms` |
| `http_errors` | `countIf(status >= 500)` |
| `sb_creates` | `count()` over `boot_events` |
| `boot_p50` / `boot_p95` | `quantile(0.50)` / `quantile(0.95)` of `boot_ms` |
| `boot_warm_pct` | `countIf(boot_mode NOT IN ('cold','')) / count()` |

Step is whitelisted to `15s | 1m | 5m | 1h`. Range max is 30 days. Workspace is always injected server-side from `X-Fcs-Workspace` — the client cannot pick it.

### `/v1/metrics/sandbox/:id`

Returns per-sandbox `cpu_pct` and `mem_bytes` series. The path param is validated against `safeID` (only `[A-Za-z0-9_-]`, ≤ 64 chars) before being inlined into the SQL.

If ClickHouse is unconfigured, both endpoints respond with `503 {"error":"clickhouse not configured","series":[]}` so the dashboard renders a friendly empty state instead of a 404.

---

## Dashboard reads

The Next.js dashboard (`dashboard/`) hits the API endpoints above and renders the time series as charts. It never talks to ClickHouse directly — the API is the only path that touches CH on the read side, which means a single CH credential issuance covers every dashboard user.

The dashboard's identity for these calls is the same bearer token it uses for the rest of the API. The workspace is derived from the org/session — never from a client-supplied header.

---

## Self-hosted ClickHouse vs ClickHouse Cloud

The same schema, the same HTTP API, the same JSONEachRow ingestion. The switch is one URL.

| | Self-hosted (default for AWS/GCP) | ClickHouse Cloud (Workers) |
| --- | --- | --- |
| URL shape | `http://clickhouse.<internal>:8123` | `https://<id>.<region>.aws.clickhouse.cloud:8443` |
| Auth | Header or query string | Basic auth in `Authorization` |
| Credentials in | GCP Secret Manager / AWS Secrets Manager / `.env.local` | `wrangler secret put CLICKHOUSE_PASSWORD` |
| Batching | Up to 256 rows or 5 s | Same |
| Schema bootstrap | API on start | API on start (Workers trust the same DDL) |

A deployment that moves the control plane to Workers but keeps the agent fleet on AWS/GCP can point both sides at ClickHouse Cloud; the API and the Workers both write, the API reads.

---

## Logs

| Component | Where |
| --- | --- |
| API (Go control plane) | `journalctl -u pukucloud-api -f` (systemd), structured slog to stdout |
| Agent | `journalctl -u pukucloud-agent -f`, structured slog to stdout |
| In-VM daemon (`pukucloud-daemon`) | Serial console (Firecracker captures to host log) |
| In-VM Postgres | `journalctl` inside the VM, plus `pukucloud-wal-archive.sh` system-log lines tagged with `pukucloud-wal-archive` |
| Cloudflare Worker | `wrangler tail --env production` |

The dashboard does not surface log search today — operators tail logs directly. Logs are intentionally separate from ClickHouse because they are much higher volume and not useful for charting.

---

## Metrics endpoints

Prometheus-format scrape endpoints:

| Endpoint | Component | Notes |
| --- | --- | --- |
| `:9100/metrics` | Agent | Firecracker-level counts (VM start/stop, snapshot hit/miss, UFFD faults) |
| `:8080/metrics` | API | HTTP handler-level metrics, registry-level counters |
| `:8081/healthz` | Agent | Liveness |
| `:8080/healthz` | API | Liveness; returns `{"status":"ok","checks":{"PUKUCLOUD_DB_DSN":"ok"}}` when the DB is reachable |

The Cloudflare Worker does not expose Prometheus metrics directly — the charts come from ClickHouse. If you scrape Prometheus, point Prometheus at the agent and API hosts.

---

## Tracing

Today there is no OTel trace exporter wired in. Request correlation is by `X-Request-Id`: the API mints or propagates one, the ClickHouse row carries it, and the dashboard renders it on hover. That is enough to follow a request through the logs (grep for the id) without standing up a tracing backend.

A future trace exporter is one of the audit items — see the production-readiness checklist in the repo root.

---

## Operating tips

- **Charts are empty.** Either the DDL bootstrap failed (check API boot logs for `clickhouse: DDL bootstrap failed`), or `PUKUCLOUD_CLICKHOUSE_URL` is unset, or the schema path is unreadable. The API returns 503 on `/v1/metrics/overview` and logs `clickhouse: not configured (PUKUCLOUD_CLICKHOUSE_URL unset)`.
- **Cardinality blow-up on `http_requests`.** If you point the dashboard at a host with raw URLs (no `normalizeRoute` somewhere in the path), drop `route` cardinality to known patterns or set TTL on `http_requests` aggressively. The default route normalizer treats segments ≥ 12 chars with at least one digit as IDs.
- **Step is a hot knob.** Dashboard pickers map to `15s | 1m | 5m | 1h`. Anything finer than `15s` is unsupported — the underlying queries are not optimized for sub-second resolution.
- **Range cap.** The API rejects `to - from > 30 days`. For longer windows, run the query directly against ClickHouse.
- **Workers flush on teardown is best-effort.** When Workers are evicted at low load, any unflushed batch is lost. The Worker sink drops on failure (not retries to disk) — by design, since the alternative is duplicated analytics.
- **Time format.** ClickHouse `DateTime64(3)` does not accept RFC3339 literals. The API formats timestamps as `YYYY-MM-DD HH:MM:SS.fff` before inlining.

---

## See also

- [architecture.md](architecture.md) — where each component writes from.
- [secrets-and-config.md](secrets-and-config.md) — `PUKUCLOUD_CLICKHOUSE_URL`, Cloudflare `CLICKHOUSE_*` secrets, GCP Secret Manager entries.
- [setup-self-host-aws.md](setup-self-host-aws.md) / [setup-self-host-gcp.md](setup-self-host-gcp.md) — ClickHouse VM sizing.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — Workers ClickHouse Cloud wiring.
- [disaster-recovery.md](disaster-recovery.md) — what to do when ClickHouse is the failed dependency.

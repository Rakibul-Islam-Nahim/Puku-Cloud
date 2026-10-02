# Secrets and configuration reference

Every environment variable, Cloudflare secret, and agent-host env file PukuCloud recognizes. Use this as the canonical reference when wiring up a new environment; for procedural setup see [setup-local-linux.md](setup-local-linux.md), [setup-local-mac.md](setup-local-mac.md), [setup-temporal-self-host.md](setup-temporal-self-host.md), or [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md).

## Contents

- [Naming conventions](#naming-conventions)
- [Agent env vars](#agent-env-vars)
- [Cloudflare Workers vars and secrets](#cloudflare-workers-vars-and-secrets)
- [Dashboard env vars](#dashboard-env-vars)
- [Postgres template env vars (in-VM)](#postgres-template-env-vars-in-vm)
- [Sentry + Temporal self-hosted](#sentry--temporal-self-hosted)
- [Local dev overrides](#local-dev-overrides)

---

## Naming conventions

- All PukuCloud env vars are prefixed `PUKUCLOUD_`.
- Per-component vars use a second-level prefix (`PUKUCLOUD_AGENT_*`, `PUKUCLOUD_DB_*`, etc.).
- The Workers control plane uses `AUTH_MODE` (no prefix) — the worker-specific subset of `PUKUCLOUD_*` plus a few unprefixed compat vars are documented in [`workers/.dev.vars.example`](../workers/.dev.vars.example).
- The legacy `PANDA*` env-var prefix is no longer recognized. Any reference to it in old guides is a bug.

There is no `PUKUCLOUD_DB_DSN` (no Postgres control plane), no `PUKUCLOUD_CLICKHOUSE_URL` (no ClickHouse), no `PUKUCLOUD_NODE_TOKEN` (no separate node-to-node auth — agents authenticate to the controller with `PUKUCLOUD_AGENT_TOKEN`).

---

## Agent env vars

The agent reads these at boot. Put them in `/etc/pukucloud/agent.env` (sourced by the systemd unit). **The agent does not live-reload — restart the service to pick up changes.**

| Variable | Example | Required? | What |
|---|---|---|---|
| `TEMPORAL_ADDRESS` | `temporal.your-domain.tld:7233` | yes | gRPC frontend of your Temporal. |
| `TEMPORAL_NAMESPACE` | `default` | no | Match what the controller uses. |
| `TEMPORAL_TASK_QUEUE` | `pukucloud-microvms` | no | Match what the controller uses. |
| `TEMPORAL_AUTH_TOKEN` | `<secret>` | only if Temporal auth enabled | Same secret as on the controller. |
| `SENTRY_DSN` | `https://abc123@sentry.your-domain.tld/1` | yes | From the `pukucloud-agent` project in Sentry. |
| `PUKUCLOUD_WORKER_ID` | `host-1` | yes | **Unique per agent.** Used as `WorkerStateDO` id and in heartbeat URLs. |
| `PUKUCLOUD_REGION` | `us-east-1` | yes | Region tag. Used in `WorkerStateDO.region` and dashboard grouping. |
| `PUKUCLOUD_ENV` | `production` | no | `production` / `staging` / `development`. |
| `PUKUCLOUD_CONTROLLER_URL` | `https://pukucloud-api.<account>.workers.dev` | yes | Where the agent POSTs heartbeats. |
| `PUKUCLOUD_AGENT_TOKEN` | `openssl rand -hex 32` | yes | Shared with the controller. Used in `Authorization: Bearer` on the heartbeat path. |
| `PUKUCLOUD_DATA_DIR` | `/var/lib/pukucloud` | no | Local chunk cache, template preseeds, PGDATA. |
| `PUKUCLOUD_LISTEN_ADDR` | `:8081` | no | Local health/metrics listener. |
| `PUKUCLOUD_METRICS_LISTEN` | `:9100` | no | Prometheus metrics endpoint. |
| `PUKUCLOUD_STREAM_DISK` | `1` | no | Enable NBD rootfs streaming (default on). |
| `PUKUCLOUD_STREAM_RESTORE` | `1` | no | Enable UFFD memory streaming (default on). |
| `PUKUCLOUD_SNAPSHOT_PREFETCH` | `0` | no | Eagerly prefetch next-template snapshots (0=off). |
| `PUKUCLOUD_DEFAULT_TTL_SECONDS` | `300` | no | Default sandbox TTL if not set per-request. |
| `PUKUCLOUD_REAPER_INTERVAL_SECONDS` | `30` | no | How often the reaper sweeps expired sandboxes. |
| `PUKUCLOUD_VSOCK_EXEC` | unset | no | Set to `1` to use vsock for exec instead of virtio-console. |
| `PUKUCLOUD_HUGEPAGES` | unset | no | Optional hugepages reservation. |
| `PUKUCLOUD_CPU_PINS` | unset | no | Optional CPU pinning for Firecracker vCPUs. |
| `PUKUCLOUD_BLOCKED_EGRESS_PORTS` | unset | no | Comma-separated ports blocked at the network namespace layer. |
| `PUKUCLOUD_NATID_POOL_SIZE` | auto | no | NAT-ID pool size for outbound-only sandboxes. |
| `PUKUCLOUD_NATID_SLOT` | unset | no | Force a specific NAT slot for testing. |
| `PUKUCLOUD_INTERNAL_IP` | auto | no | Internal IP the controller should reach this agent on. |
| `PUKUCLOUD_CERT_DIR` | `/etc/pukucloud/certs` | no | TLS certs for the db-proxy tunnel. |
| `PUKUCLOUD_SNI_SUFFIX` | `.db.example.com` | no | SNI suffix the db-proxy uses. |
| `PUKUCLOUD_BINARY_URL` | unset | no | Override URL for the agent binary on install/update. |
| `PUKUCLOUD_DAEMON_BIN` | `/usr/local/bin/pukucloud-daemon` | no | Path to the in-VM daemon helper. |
| `PUKUCLOUD_INIT_BIN` | `/usr/local/bin/pukucloud-init` | no | Path to the in-VM init helper. |
| `PUKUCLOUD_SHARED_KEY` | unset | no | Local-only HMAC for in-VM IPC. |
| `PUKUCLOUD_GCS_BUCKET` | unset | no | (Legacy GCS adapter — see Roadmap.) |
| `PUKUCLOUD_S3_BUCKET` | unset | no | (Legacy S3 adapter — see Roadmap.) |
| `PUKUCLOUD_SNAPSHOT_BUCKET` | unset | no | Snapshot-specific bucket (defaults to one of the above). |

---

## Cloudflare Workers vars and secrets

Set non-secret values in `workers/wrangler.toml` `[vars]` blocks; set secrets with `wrangler secret put`. Workers read secrets at deploy time.

### Plain vars (`[vars]` in `wrangler.toml`)

| Variable | Example | What |
|---|---|---|
| `PUKUCLOUD_ENV` | `production` | `production` / `staging` / `development`. |
| `PUKUCLOUD_API_VERSION` | `0.1.0` | Reported by `/version`. |
| `PUKUCLOUD_DASHBOARD_URL` | `https://app.example.com` | Dashboard origin (for CORS, invite links). |
| `PUKUCLOUD_CONTROLLER_URL` | `https://pukucloud-api.<account>.workers.dev` | Echoed back to the dashboard for self-anchoring links. |
| `AUTH_MODE` | `jwt` | `stub` (default) / `tokens` / `jwt`. **Always `jwt` in production.** |
| `TEMPORAL_ADDRESS` | `https://temporal.your-domain.tld:8088` | Temporal HTTP API (port 8088 in the new docker-compose). |
| `TEMPORAL_NAMESPACE` | `default` | Same as the agents. |
| `TEMPORAL_TASK_QUEUE` | `pukucloud-microvms` | Same as the agents. |

### Secrets (`wrangler secret put`)

| Secret | What |
|---|---|
| `PUKUCLOUD_AGENT_TOKEN` | Shared with every agent. Required for `/v1/internal/agents/*` auth. |
| `PUKUCLOUD_ADMIN_TOKEN` | Bootstrap admin token; used to mint the first `/v1/me/tokens` API token. |
| `SENTRY_DSN` | DSN for the `pukucloud-controller` project. |
| `SUPABASE_JWKS_URL` | JWKS endpoint for JWT verification (or any OIDC IdP). |
| `SUPABASE_ISSUER` | Expected `iss` claim. |
| `SUPABASE_AUDIENCE` | Expected `aud` claim. |
| `TEMPORAL_AUTH_TOKEN` | Only if Temporal auth is enabled. |
| `R2_SNAPSHOT_TOKEN` | Optional. `<access_key>:<secret_key>` — enables presigned Range GETs. |

### Bindings (declared in `wrangler.toml`)

| Binding | Type | What |
|---|---|---|
| `DB` | D1 | `pukucloud-db` (or `pukucloud-db-staging`). Migrations in `workers/migrations/`. |
| `WORKER_STATE` | Durable Object namespace | One `WorkerStateDO` per `PUKUCLOUD_WORKER_ID`. |
| `SNAPSHOTS` | R2 | Snapshot seeds, UFFD/NBD pages. |
| `CACHE` | KV | JWKS pin, NAT-ID prewarm, rate limit. |
| `TEMPORAL` | Worker entrypoint | Used to start workflows from the controller. |

Verify with `wrangler secret list` and `wrangler d1 list` / `wrangler kv:namespace list` / `wrangler r2 bucket list`.

---

## Dashboard env vars

Set at **build time** (Next.js inlines `NEXT_PUBLIC_*` into the bundle).

| Variable | What |
|---|---|
| `NEXT_PUBLIC_PUKUCLOUD_API` | Base URL of the controller the dashboard talks to. |
| `NEXT_PUBLIC_PUKUCLOUD_AUTH` | `token` to use API-token auth instead of JWT. |
| `NEXT_PUBLIC_PUKUCLOUD_ENV` | `production` / `staging` / `local`. |
| `NEXT_PUBLIC_PUKUCLOUD_STUB_USER_EMAIL` | Stub-mode user identity for local dev. |

---

## Postgres template env vars (in-VM)

The in-VM Postgres uses env vars loaded from `/etc/pukucloud/postgres.env` (or injected by the agent at restore). They are documented inside the template: [`templates/postgres-16/scripts/autostart.sh`](../templates/postgres-16/scripts/autostart.sh).

| Variable | Default | What |
|---|---|---|
| `PUKUCLOUD_DB_IDLE_AFTER_SECONDS` | unset | Idle reaper threshold for managed databases. |
| `PUKUCLOUD_DB_FENCING_*` | unset | Managed-Postgres fencing tuning. |
| `PUKUCLOUD_DB_FAILOVER_*` | unset | Managed-Postgres failover tuning. |
| `PUKUCLOUD_DB_ARCHIVE_*` | unset | Managed-Postgres WAL archive tuning. |

---

## Sentry + Temporal self-hosted

The self-hosted stacks in `infra/sentry/` and `infra/temporal/` use their own docker-compose env:

### Sentry (`infra/sentry/docker-compose.yml`)

| Variable | Default | What |
|---|---|---|
| `SENTRY_SECRET_KEY` | `REPLACE_WITH_openssl_rand_hex_32` | Cookie + signing secret. `openssl rand -hex 32` — paste the same value in all 3 places. |
| `SENTRY_EMAIL_HOST` | `smtp.example.com` | SMTP relay for alert emails. |
| `SENTRY_EMAIL_PORT` | `587` | SMTP port. |
| `SENTRY_EMAIL_USER` | unset | SMTP user. |
| `SENTRY_EMAIL_PASSWORD` | unset | SMTP password. |
| `SENTRY_EMAIL_FROM` | `noreply@example.com` | From address. |
| `SENTRY_EMAIL_USE_TLS` | `true` | Use STARTTLS. |

### Temporal (`infra/temporal/docker-compose.yml`)

| Variable | Default | What |
|---|---|---|
| `TEMPORAL_DB` | `postgres12` | Persistence driver. |
| `TEMPORAL_ADDRESS` | `temporal:7233` | gRPC listen port (the prod overlay moves this behind TLS). |
| `TEMPORAL_AUTH_ENABLED` | `false` | Enable mTLS auth. |
| `TEMPORAL_TLS` | `false` | Enable TLS for the frontend. |
| `TEMPORAL_AUTH_TOKEN` | unset | Bearer token for Temporal auth (when `TEMPORAL_AUTH_ENABLED=true`). |
| `TEMPORAL_SERVER_NAME` | unset | Expected server name in the TLS cert. |

The prod overlay (`infra/temporal/docker-compose.prod.yml`) mounts certs at `/etc/temporal/certs` and sets `TEMPORAL_TLS=1` + `TEMPORAL_AUTH_ENABLED=true`.

---

## Local dev overrides

`/.env.local.example` is the template — copy to `.env.local` and edit. The `make tidy` target does not read `.env.local`; only the agent binary does, via `godotenv` (or your shell exporting the vars).

For local dev, the defaults are:

- `AUTH_MODE=stub` — any `X-Stub-User` header is accepted. Never use in production.
- `PUKUCLOUD_LISTEN_ADDR=:8081` (agent's local health port).
- `PUKUCLOUD_DATA_DIR=/var/lib/pukucloud`.

---

## See also

- [architecture.md](architecture.md) — where each var lives in the wire format.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md)
- [setup-local-linux.md](setup-local-linux.md)
- [setup-local-mac.md](setup-local-mac.md)
- [setup-temporal-self-host.md](setup-temporal-self-host.md)
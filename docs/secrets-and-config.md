# Secrets and configuration reference

Every environment variable, Cloudflare secret, and cloud secret-manager entry PukuCloud recognizes. Use this as the canonical reference when wiring up a new environment; for procedural setup see [setup-local-mac.md](setup-local-mac.md), [setup-local-linux.md](setup-local-linux.md), [setup-self-host-aws.md](setup-self-host-aws.md), [setup-self-host-gcp.md](setup-self-host-gcp.md), or [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md).

## Contents

- [Naming conventions](#naming-conventions)
- [Runtime environment variables](#runtime-environment-variables)
  - [Agent](#agent)
  - [API (Go control plane)](#api-go-control-plane)
  - [Database (Postgres template)](#database-postgres-template)
  - [Cloudflare Workers control plane](#cloudflare-workers-control-plane)
  - [Dashboard](#dashboard)
- [Secrets management](#secrets-management)
  - [Cloudflare Workers](#cloudflare-workers)
  - [GCP Secret Manager](#gcp-secret-manager)
  - [AWS Secrets Manager](#aws-secrets-manager)
- [Local dev overrides](#local-dev-overrides)

---

## Naming conventions

- All PukuCloud env vars are prefixed `PUKUCLOUD_`.
- Per-component vars use a second-level prefix (`PUKUCLOUD_DB_*`, `PUKUCLOUD_AGENT_*`, etc.).
- The Workers control plane uses `AUTH_MODE` (no prefix) — the worker-specific subset of `PUKUCLOUD_*` plus a few unprefixed compat vars are documented in [`workers/.dev.vars.example`](../workers/.dev.vars.example).
- The legacy `PANDA*` env-var prefix is no longer recognized. Any reference to it in old guides is a bug.

---

## Runtime environment variables

The canonical list with defaults lives in [`/.env.local.example`](../.env.local.example). The subset below is what you'll actually touch in a real deploy.

### Agent

| Variable | Default | What |
| --- | --- | --- |
| `PUKUCLOUD_AGENT_ID` | hostname | Identifier shown in scheduler heartbeats and audit. |
| `PUKUCLOUD_AGENT_ENDPOINT` | auto | Hostname the API uses to reach this agent (overrides URL). |
| `PUKUCLOUD_AGENT_SOCKET` | `/run/fcsandbox/agent.sock` | Optional local Unix socket. |
| `PUKUCLOUD_LISTEN_ADDR` | `:8081` | HTTP listener for control-plane and intra-host hops. |
| `PUKUCLOUD_METRICS_LISTEN` | `:9100` | Prometheus metrics endpoint. |
| `PUKUCLOUD_LISTEN_TCP` | unset | Optional TCP listener (legacy). |
| `PUKUCLOUD_DATA_DIR` | `/var/lib/pukucloud` | Chunk cache, template preseeds, PGDATA. |
| `PUKUCLOUD_DATA_SIZE_GB` | auto | Initial sizing hint for the data volume (logs only). |
| `PUKUCLOUD_CPU_PINS` | unset | Optional CPU pinning for Firecracker vCPUs. |
| `PUKUCLOUD_HUGEPAGES` | unset | Optional hugepages reservation. |
| `PUKUCLOUD_NOHUGE_TEMPLATES` | unset | Disable hugepages for specific template names. |
| `PUKUCLOUD_NATID_POOL_SIZE` | auto | NAT-ID pool size for outbound-only sandboxes. |
| `PUKUCLOUD_NATID_SLOT` | unset | Force a specific NAT slot for testing. |
| `PUKUCLOUD_INTERNAL_IP` | auto | Internal IP the API should reach this agent on. |
| `PUKUCLOUD_BLOCKED_EGRESS_PORTS` | unset | Comma-separated ports blocked at the network namespace layer. |
| `PUKUCLOUD_DEFAULT_TTL_SECONDS` | `300` | Default sandbox TTL if not set per-request. |
| `PUKUCLOUD_REAPER_INTERVAL_SECONDS` | `30` | How often the reaper sweeps expired sandboxes. |
| `PUKUCLOUD_VSOCK_EXEC` | unset | Set to `1` to use vsock for exec instead of virtio-console. |
| `PUKUCLOUD_STREAM_DISK` | `1` | Enable demand-paged rootfs (NBD) streaming. |
| `PUKUCLOUD_STREAM_RESTORE` | `1` | Enable UFFD memory streaming on restore. |
| `PUKUCLOUD_SNAPSHOT_PREFETCH` | `0` | Eagerly prefetch next-template snapshots (0=off). |
| `PUKUCLOUD_CERT_DIR` | `/etc/pukucloud/certs` | TLS certs for the db-proxy tunnel. |
| `PUKUCLOUD_SNI_SUFFIX` | unset | SNI suffix the db-proxy uses (e.g. `.db.<zone>`). |
| `PUKUCLOUD_GCS_BUCKET` | unset | GCS bucket for snapshot seeds / UFFD / NBD streaming. |
| `PUKUCLOUD_S3_BUCKET` | unset | S3 bucket (used on AWS fleets for kernels / templates / bin). |
| `PUKUCLOUD_SNAPSHOT_BUCKET` | unset | Snapshot-specific bucket (defaults to `PUKUCLOUD_S3_BUCKET`/`PUKUCLOUD_GCS_BUCKET`). |
| `PUKUCLOUD_DASHBOARD_BUCKET` | unset | Bucket the dashboard is served from. |
| `PUKUCLOUD_BINARY_URL` | unset | Override URL for the agent binary on install/update. |
| `PUKUCLOUD_DAEMON_BIN` | `/usr/local/bin/pukucloud-daemon` | Path to the in-VM daemon helper. |
| `PUKUCLOUD_INIT_BIN` | `/usr/local/bin/pukucloud-init` | Path to the in-VM init helper. |
| `PUKUCLOUD_SHARED_KEY` | unset | Local-only HMAC for in-VM IPC. |
| `PUKUCLOUD_ZONE` / `PUKUCLOUD_ZONE_NAME` | unset | GCP zone, used in startup scripts. |
| `PUKUCLOUD_REGION` | unset | Region label for audit. |

### API (Go control plane)

| Variable | Default | What |
| --- | --- | --- |
| `PUKUCLOUD_ENV` | `local` | `production` / `staging` / `local`. Affects logging and CORS. |
| `PUKUCLOUD_API_LISTEN` | `:8080` | HTTP listener. |
| `PUKUCLOUD_API_FQDN` | auto | Used in link building (invites, dashboard URLs). |
| `PUKUCLOUD_APP_FQDN` | auto | Dashboard origin used for invite URLs etc. |
| `PUKUCLOUD_DASHBOARD_URL` | `http://localhost:3000` | Dashboard origin (for CORS + invite links). |
| `PUKUCLOUD_API_VERSION` | `0.1.0` | Reported by `/version`. |
| `PUKUCLOUD_AUTH_MODE` | `stub` | `stub` / `tokens` / `jwt`. See [Auth boundaries](architecture.md#auth-boundaries). |
| `PUKUCLOUD_AUTH_SKIP_PREFIXES` | unset | Comma-separated URL prefixes that bypass auth (e.g. `/healthz`). |
| `PUKUCLOUD_DB_DRIVER` | `sqlite` | `sqlite` or `postgres`. |
| `PUKUCLOUD_DB_DSN` | auto | Postgres DSN. Empty → sqlite at `$PUKUCLOUD_DATA_DIR/pukucloud.db`. |
| `PUKUCLOUD_DB_IDLE_AFTER_SECONDS` | unset | Idle reaper threshold for managed databases. |
| `PUKUCLOUD_CLICKHOUSE_URL` | unset | ClickHouse HTTP endpoint for events. |
| `PUKUCLOUD_NODE_TOKEN` | unset | Shared bearer between control plane and agents (`X-Node-Token`). |
| `PUKUCLOUD_AGENT_TOKEN` | unset | Shared bearer the Workers control plane injects on agent hops. |
| `PUKUCLOUD_AGENT_URLS` | unset | Comma-separated `host:port` for multi-node agents. |
| `PUKUCLOUD_ADMIN_TOKEN` | unset | Bootstrap admin token used to mint the first `/v1/me/tokens`. |
| `PUKUCLOUD_SUPABASE_JWKS_URL` | unset | JWKS endpoint for JWT auth. |
| `PUKUCLOUD_STUB_USER_EMAIL` / `_ID` / `_ORG_ID` / `_WORKSPACE` | dev defaults | Stub user attributes when `AUTH_MODE=stub`. |
| `PUKUCLOUD_CONTROL_PLANE_URL` | unset | Used by CLI to locate the API. |
| `PUKUCLOUD_DB_ARCHIVE_*` | unset | Managed-Postgres archive tuning. |
| `PUKUCLOUD_DB_FENCING_*` | unset | Managed-Postgres fencing tuning. |
| `PUKUCLOUD_DB_FAILOVER_*` | unset | Managed-Postgres failover tuning. |

### Database (Postgres template)

The in-VM Postgres uses env vars loaded from `/etc/pukucloud/postgres.env` (or injected by the agent at restore). They are documented inside the template: [`templates/postgres-16/scripts/autostart.sh`](../templates/postgres-16/scripts/autostart.sh).

### Cloudflare Workers control plane

| Variable / secret | Scope | What |
| --- | --- | --- |
| `PUKUCLOUD_ENV` | var | `production` / `staging`. |
| `PUKUCLOUD_API_VERSION` | var | Reported by `/version`. |
| `PUKUCLOUD_AGENT_URLS` | var | Comma-separated `host:port` for multi-node agents. |
| `PUKUCLOUD_DASHBOARD_URL` | var | Dashboard origin (for CORS). |
| `PUKUCLOUD_AGENT_TOKEN` | secret | Shared bearer the Worker injects on agent hops. |
| `PUKUCLOUD_ADMIN_TOKEN` | secret | Bootstrap admin token. |
| `PUKUCLOUD_SUPABASE_JWKS_URL` | secret | JWKS endpoint for JWT auth. |
| `SUPABASE_JWKS_URL` | secret | Alternate name (legacy); equivalent. |
| `SUPABASE_ISSUER` | secret | Expected `iss` claim. |
| `SUPABASE_AUDIENCE` | secret | Expected `aud` claim. |
| `CLICKHOUSE_URL` | secret | ClickHouse Cloud HTTPS endpoint. |
| `CLICKHOUSE_USER` | secret | ClickHouse user. |
| `CLICKHOUSE_PASSWORD` | secret | ClickHouse password. |
| `R2_SNAPSHOT_TOKEN` | secret | Optional. `access_key:secret_key` — enables presigned Range GETs. |
| `AUTH_MODE` | var | `stub` (default) / `tokens` / `jwt`. |

D1 / R2 / KV bindings are declared in [`workers/wrangler.toml`](../workers/wrangler.toml) and are not secrets.

### Dashboard

| Variable | What |
| --- | --- |
| `NEXT_PUBLIC_PUKUCLOUD_API` | Base URL of the API the dashboard talks to. |
| `NEXT_PUBLIC_PUKUCLOUD_AUTH` | `token` to use API-token auth instead of JWT. |
| `NEXT_PUBLIC_PUKUCLOUD_ENV` | `production` / `staging` / `local`. |
| `NEXT_PUBLIC_PUKUCLOUD_STUB_USER_EMAIL` | Stub-mode user identity for local dev. |

---

## Secrets management

### Cloudflare Workers

```bash
npx wrangler secret put <NAME>            # production env
npx wrangler secret put <NAME> --env staging
```

See [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md#step-5--set-secrets) for the full list of secrets to set.

### GCP Secret Manager

The `dev-gcp-multi` Terraform env manages these:

| Secret name | Used by |
| --- | --- |
| `pukucloud-database-url` | Edge + Agent (Postgres DSN) |
| `pukucloud-clickhouse-url` | Edge + Agent (ClickHouse HTTP URL) |
| `pukucloud-node-token` | Edge + Agent (bearer auth between edge↔agent) |
| `pukucloud-supabase-jwks-url` | Edge (JWT verification) |

Update a value:

```bash
echo -n "NEW_VALUE" | gcloud secrets versions add pukucloud-database-url --data-file=-
```

Running instances read these **once at boot**, so a change requires a rolling restart. See [setup-self-host-gcp.md#secret-update](setup-self-host-gcp.md#secret-update).

### AWS Secrets Manager

The `dev-aws` Terraform env stores the same four values under matching names. Update via:

```bash
aws secretsmanager put-secret-value \
  --secret-id pukucloud-database-url \
  --secret-string "NEW_VALUE"
```

Then trigger a rolling restart of the edge ASG.

---

## Local dev overrides

`/.env.local.example` is the template — copy to `.env.local` and edit. The `make tidy` target does not read `.env.local`; only the API and agent binaries do, via `godotenv` (or your shell exporting the vars).

For local dev, the defaults are:

- `PUKUCLOUD_AUTH_MODE=stub` — any `X-Stub-User` header is accepted.
- `PUKUCLOUD_DB_DRIVER=sqlite` — no Postgres required.
- `PUKUCLOUD_LISTEN_ADDR=:8080` (API), `PUKUCLOUD_AGENT_SOCKET=/run/fcsandbox/agent.sock` (agent).

Never run `PUKUCLOUD_AUTH_MODE=stub` against a deployed environment — see [disaster-recovery.md](disaster-recovery.md).

---

## See also

- [architecture.md](architecture.md) — where each var lives in the wire format.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md)
- [setup-self-host-aws.md](setup-self-host-aws.md)
- [setup-self-host-gcp.md](setup-self-host-gcp.md)
- [setup-local-mac.md](setup-local-mac.md)
- [setup-local-linux.md](setup-local-linux.md)
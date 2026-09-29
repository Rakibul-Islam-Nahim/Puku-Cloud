# Cloudflare control plane setup

Stand up the PukuCloud control plane on Cloudflare Workers (D1 + R2 + KV), wire it to your existing Firecracker agent fleet, and confirm end-to-end sandbox creation. This is the production deployment target for the control plane; agents stay where they are (bare-metal EC2, GCP MIG, or a single Linux KVM host).

If you want a self-hosted Go control plane instead, see [setup-self-host-aws.md](setup-self-host-aws.md) or [setup-self-host-gcp.md](setup-self-host-gcp.md).

## Contents

- [What this deploys](#what-this-deploys)
- [Prerequisites](#prerequisites)
- [Step 1 — Cloudflare account and DNS](#step-1--cloudflare-account-and-dns)
- [Step 2 — Local tools](#step-2--local-tools)
- [Step 3 — Provision D1, KV, and R2](#step-3--provision-d1-kv-and-r2)
- [Step 4 — Configure wrangler.toml](#step-4--configure-wranglertoml)
- [Step 5 — Set secrets](#step-5--set-secrets)
- [Step 6 — Apply D1 migrations](#step-6--apply-d1-migrations)
- [Step 7 — Deploy](#step-7--deploy)
- [Step 8 — Smoke test](#step-8--smoke-test)
- [Step 9 — Front the db-proxy with Spectrum](#step-9--front-the-db-proxy-with-spectrum)
- [Step 10 — Switch the dashboard](#step-10--switch-the-dashboard)
- [Cutover and rollback](#cutover-and-rollback)
- [Cost expectations](#cost-expectations)
- [Production gaps to track](#production-gaps-to-track)

---

## What this deploys

```text
clients ──► Cloudflare Workers (this repo's workers/ directory)
                │
                ├── D1   (orgs, members, tokens, DB registry, snapshots, leases)
                ├── R2   (vm.mem, vmstate, rootfs.ext4, volume ext4 blobs)
                ├── KV   (JWKS pin, NAT-ID prewarm, rate limit)
                └──►   agent fleet (one HTTPS hop per /v1/* request)
                          │
                          └── Firecracker microVMs (stays on KVM)
```

The Firecracker agents and the workload microVMs **do not move** — Firecracker needs `/dev/kvm` and that means bare metal or nested virt. Only the control plane moves to Cloudflare.

---

## Prerequisites

You need all of the following before starting:

| Requirement | Notes |
| --- | --- |
| Cloudflare account with Workers + D1 + R2 + KV + Spectrum entitlement | Free tier works for evaluation; production needs paid. |
| Wildcard DNS zone delegated to Cloudflare | e.g. `example.com`. The Worker will live at `pukucloud-api.<zone>`. |
| Firecracker agent fleet reachable from the CF edge | Either publicly routable hostnames, or via Cloudflare Tunnel / WARP. |
| `wrangler` >= 3.x | `npm i -g wrangler` |
| Node.js 22.x | Matches `docs-site/.nvmrc`; required for `vitest-pool-workers`. |
| The Go API can stay up during cutover | Used as rollback target for 24 h after production cutover. |

---

## Step 1 — Cloudflare account and DNS

1. Sign in to the Cloudflare dashboard.
2. Add your zone (`example.com`) and ensure nameservers are delegated.
3. Confirm D1, R2, KV, and Spectrum are enabled on your plan (Spectrum is a paid add-on; everything else has a free tier).

---

## Step 2 — Local tools

```bash
# Node 22 (matches the rest of the repo)
nvm install 22 && nvm use 22

# Wrangler
npm install -g wrangler
wrangler --version          # >= 3.x

# Authenticate
wrangler login
```

You'll be prompted to authorize wrangler against your Cloudflare account.

---

## Step 3 — Provision D1, KV, and R2

Run each command and capture the IDs / names it prints — they go into `wrangler.toml`.

```bash
cd workers

# D1 — one per environment
npx wrangler d1 create pukucloud-db
npx wrangler d1 create pukucloud-db-staging

# KV — one namespace per environment, both bound to the "CACHE" binding
npx wrangler kv:namespace create CACHE
npx wrangler kv:namespace create CACHE --env staging

# R2 — snapshot / seed / volume / NBD backing store
npx wrangler r2 bucket create pukucloud-snapshots
npx wrangler r2 bucket create pukucloud-snapshots-staging
```

Each `wrangler d1 create` prints a `database_id`. Each `wrangler kv:namespace create` prints an `id`. Paste these into `wrangler.toml` (see Step 4).

---

## Step 4 — Configure `wrangler.toml`

Open `workers/wrangler.toml` and replace the three placeholders:

```toml
[[d1_databases]]
binding = "DB"
database_name = "pukucloud-db"
database_id = "<paste from wrangler d1 create pukucloud-db>"
migrations_dir = "migrations"

[env.staging]
# ...
[[env.staging.d1_databases]]
binding = "DB"
database_name = "pukucloud-db-staging"
database_id = "<paste from wrangler d1 create pukucloud-db-staging>"

[[kv_namespaces]]
binding = "CACHE"
id = "<paste from wrangler kv:namespace create CACHE>"

[env.staging]
[[env.staging.kv_namespaces]]
binding = "CACHE"
id = "<paste from wrangler kv:namespace create CACHE --env staging>"
```

Then set the public vars:

```toml
[vars]
PUKUCLOUD_ENV = "production"
PUKUCLOUD_API_VERSION = "0.1.0"
# Comma-separated host:port for multi-node.
PUKUCLOUD_AGENT_URLS = "https://agent-1.example.com:9090,https://agent-2.example.com:9090"
PUKUCLOUD_DASHBOARD_URL = "https://app.example.com"

[env.staging.vars]
PUKUCLOUD_ENV = "staging"
PUKUCLOUD_DASHBOARD_URL = "https://staging.app.example.com"
PUKUCLOUD_AGENT_URLS = "https://agent-staging.example.com:9090"
```

> Don't put any secret values into `wrangler.toml`. Use `wrangler secret put` (Step 5).

---

## Step 5 — Set secrets

Run once per environment. The `--env` flag picks the right scope.

```bash
# Shared bearer the Worker injects on every hop to an agent.
npx wrangler secret put PUKUCLOUD_AGENT_TOKEN        --env production
npx wrangler secret put PUKUCLOUD_AGENT_TOKEN        --env staging

# Bootstrap admin token used to mint the first API token via /v1/me/tokens.
npx wrangler secret put PUKUCLOUD_ADMIN_TOKEN        --env production

# Supabase (or any OIDC IdP) — JWKS verification for JWT callers.
npx wrangler secret put SUPABASE_JWKS_URL            --env production
npx wrangler secret put SUPABASE_ISSUER              --env production
npx wrangler secret put SUPABASE_AUDIENCE            --env production

# ClickHouse — JSONEachRow event sink.
npx wrangler secret put CLICKHOUSE_URL               --env production
npx wrangler secret put CLICKHOUSE_USER              --env production
npx wrangler secret put CLICKHOUSE_PASSWORD          --env production

# Optional: enables presigned Range-GETs against R2 from the agent.
# Format: "<access_key>:<secret_key>"
npx wrangler secret put R2_SNAPSHOT_TOKEN            --env production
```

Repeat for `--env staging` as needed.

---

## Step 6 — Apply D1 migrations

```bash
# Local first (uses the bundled SQLite-backed D1 in wrangler dev)
npx wrangler d1 migrations apply pukucloud-db --local

# Remote
npx wrangler d1 migrations apply pukucloud-db            --remote
npx wrangler d1 migrations apply pukucloud-db-staging    --remote
```

Migrations live under `workers/migrations/` and are forward-only.

---

## Step 7 — Deploy

```bash
# Staging first
npx wrangler deploy --env staging

# Production after staging has been clean for at least a week
npx wrangler deploy --env production
```

`wrangler deploy` will print the URL of the deployed Worker. By default it's `https://pukucloud-api.<your-subdomain>.workers.dev` until you attach a custom domain.

To attach a custom domain (`api.example.com`), add to `wrangler.toml`:

```toml
routes = [
  { pattern = "api.example.com/*", custom_domain = true },
]
```

Then re-run `npx wrangler deploy`. Cloudflare will provision the certificate automatically.

---

## Step 8 — Smoke test

```bash
# Health
curl -sS https://pukucloud-api-staging.<your-domain>/healthz
# Expected: {"status":"ok"}

# Version
curl -sS https://pukucloud-api-staging.<your-domain>/version

# Readiness (probes D1 + R2)
curl -sS https://pukucloud-api-staging.<your-domain>/readyz
```

Mint a token via the stub auth path (only available when `PUKUCLOUD_AUTH_MODE=stub`):

```bash
curl -sS -X POST https://pukucloud-api-staging.<your-domain>/v1/me/tokens \
  -H 'X-Stub-User: dev' -H 'Content-Type: application/json' \
  -d '{"label":"smoke"}'
# Returns {"token":"pds_...","prefix":"pds_..."} — the plaintext is shown ONCE.
```

Create a sandbox to confirm the agent proxy works:

```bash
TOK="pds_..."   # from above

curl -sS -X POST https://pukucloud-api-staging.<your-domain>/v1/sandboxes \
  -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}'
# Returns {"id":"sb_...","state":"starting",...}

# After a few hundred ms, the sandbox should be ready:
curl -sS https://pukucloud-api-staging.<your-domain>/v1/sandboxes/<id> \
  -H "Authorization: Bearer $TOK"
```

If the agent-proxy hop fails, check `wrangler tail` for the Worker's live log stream.

---

## Step 9 — Front the db-proxy with Spectrum

`*.db.<zone>:5432` traffic must reach the db-proxy VM (which then tunnels to the right agent). Cloudflare Spectrum is the cheapest way to preserve TLS SNI through the proxy.

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_ZONE_ID=... \
DB_PROXY_HOSTNAME=db.example.com \
DB_PROXY_ORIGIN=<public-ip-of-db-proxy-vm>:5432 \
npx tsx workers/scripts/cf-spectrum.ts
```

The script is idempotent — re-run it freely. See [`workers/scripts/cf-spectrum.ts`](../workers/scripts/cf-spectrum.ts).

---

## Step 10 — Switch the dashboard

The dashboard reads its API base from `NEXT_PUBLIC_PUKUCLOUD_API`. To point it at the new control plane:

```bash
# dashboard/.env.local
echo 'NEXT_PUBLIC_PUKUCLOUD_API=https://pukucloud-api.<your-domain>' > dashboard/.env.local
```

Redeploy the dashboard:

```bash
bash deploy/deploy-dashboard-cf.sh
```

Or, manually:

```bash
cd dashboard
npm install
npx @cloudflare/next-on-pages
npx wrangler pages deploy .vercel/output/static
```

---

## Cutover and rollback

### Cutover

1. Run staging for at least a week with real traffic. Watch Cloudflare logs, ClickHouse events, and Grafana dashboards.
2. Promote to production: `npx wrangler deploy --env production`.
3. Update the wildcard DNS for `pukucloud-api.<zone>` to point at the new Worker route (Cloudflare does this automatically if you used `routes = [...]`).
4. Leave the old Go API running for a 24-hour rollback window.

### Rollback

If something goes wrong after cutover:

1. Revert DNS for `pukucloud-api.<zone>` to the old Go API origin.
2. Cloudflare Workers keep running but receive zero traffic — no harm done.
3. Investigate via `npx wrangler tail --env production`.
4. When fixed, re-point DNS back at the Worker.

---

## Cost expectations

A modest self-host (≈10 sandboxes/day, 1 managed database) should land under **$5/mo** of Cloudflare spend. The bigger savings come from decommissioning your always-on API VMs and your self-hosted ClickHouse.

| Item | Pricing |
| --- | --- |
| Workers | Free tier covers ≈100k req/day; paid is $0.30/M requests + $0.02/M CPU-ms. |
| D1 | Free 5 GB/day; paid $0.75/GB-mo. |
| R2 | $0.015/GB-mo + zero egress (the killer feature for UFFD/NBD Range GETs). |
| KV | $0.50/GB-mo storage + per-read fees. |
| Spectrum | $1/GB processed on the `*.db.<zone>` hostname. |
| ClickHouse Cloud | Production starts around $50/mo (3-replica minimum on the smallest tier). |

---

## Production gaps to track

The Workers control plane is functional for evaluation, but the production cutover requires closing these gaps first. They are listed in priority order; none block a single evaluation deploy.

**P0 — block first production cutover**

- D1 / KV placeholders replaced with real IDs (Step 3 above).
- All secrets set (Step 5 above).
- WebSocket / `pg_tunnel` upgrade working for `/v1/databases/{id}/proxy/[...]`.
- Agent auth boundary documented: the Worker forwards the user's `pds_*` token and the shared `PUKUCLOUD_AGENT_TOKEN` in the same `Authorization` header.
- `POST /v1/sandboxes` enforces a template allow-list (legacy rootfs paths blocked).
- Org endpoints: reserved-slug denylist, UUID-shape rejection, role gate on `POST /v1/orgs/:id/members`.
- Workers added to CI (this is already done in the current repo).

**P1 — production-grade**

- Readiness probe includes agent capacity check (not just D1 + R2).
- Scheduler is capacity-aware, not just a stable-hash round-robin.
- First-party templates seeded with `is_global = true` (base, code-interpreter, agent, postgres-16).
- DB catalogue includes failover metadata + a `/v1/databases/{id}/connection` endpoint.
- Snapshot create-recording writes a `snapshots` row; `DELETE` purges R2.
- ClickHouse sink durable across isolate eviction (Queues or Durable Object).
- Dashboard API base switched with rollback flag.

**P2 — quality**

- OpenAPI spec served at `/openapi.json` and `/v1/openapi.json`.
- Prometheus `/metrics`.
- OTel tracing.
- CORS allowlist (not echo-origin).
- Stub-mode blocked in production deployments.
- Empty fleet returns 503, not 500.
- NATID list served from D1 (multi-node).
- `X-Node-Token` propagation for inter-node identity.

---

## See also

- [architecture.md](architecture.md)
- [secrets-and-config.md](secrets-and-config.md)
- [observability.md](observability.md)
- [disaster-recovery.md](disaster-recovery.md)
- [workers/README.md](../workers/README.md)
- [workers/MIGRATION_TO_CLOUDFLARE.md](../workers/MIGRATION_TO_CLOUDFLARE.md)
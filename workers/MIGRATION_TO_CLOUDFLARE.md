# Migration: Control Plane → Cloudflare

Step-by-step cutover from the self-hosted Go control plane to the
Cloudflare Workers implementation in this directory. The Firecracker
agents stay where they are (bare-metal EC2 `c5n.metal` or GCP MIG with
nested VT-x).

## 0. Pre-flight

- You own a Cloudflare account with Workers + D1 + R2 + KV + Spectrum
  entitlement.
- A wildcard DNS zone is delegated to Cloudflare (e.g. `example.com`).
- Firecracker agent fleet is reachable from the public internet (or at
  least from the Cloudflare edge via Cloudflare Tunnel / WARP).
- `wrangler` is installed locally (`npm i -g wrangler`).
- Existing Go API is running on a host we can leave up during cutover.

## 1. Stand up the new control plane (Workers)

```bash
cd workers
npm install
npx wrangler login                          # one-time
```

In `wrangler.toml`:

- Replace `REPLACE_WITH_D1_ID` with the output of:
  ```bash
  npx wrangler d1 create pukucloud-db
  npx wrangler d1 create pukucloud-db-staging   # for staging env
  ```
- Replace `REPLACE_WITH_KV_ID` with:
  ```bash
  npx wrangler kv:namespace create CACHE
  npx wrangler kv:namespace create CACHE --env staging
  ```
- Set `PUKUCLOUD_AGENT_URLS` to your agent fleet (`https://agent-1.internal.example.com:9090,...`).
- Set `PUKUCLOUD_DASHBOARD_URL` to the existing dashboard URL.

```bash
npx wrangler r2 bucket create pukucloud-snapshots
npx wrangler r2 bucket create pukucloud-snapshots-staging
npx wrangler d1 migrations apply pukucloud-db --remote
npx wrangler d1 migrations apply pukucloud-db-staging --remote
```

Set secrets (do this per env):

```bash
npx wrangler secret put PUKUCLOUD_AGENT_TOKEN
npx wrangler secret put SUPABASE_JWKS_URL
npx wrangler secret put SUPABASE_ISSUER
npx wrangler secret put SUPABASE_AUDIENCE
npx wrangler secret put CLICKHOUSE_URL
npx wrangler secret put CLICKHOUSE_USER
npx wrangler secret put CLICKHOUSE_PASSWORD
npx wrangler secret put R2_SNAPSHOT_TOKEN         # optional, enables presign mode
```

Deploy to staging first:

```bash
npx wrangler deploy --env staging
```

Smoke test:

```bash
curl -sS https://pukucloud-api-staging.<your-domain>/healthz
curl -sS https://pukucloud-api-staging.<your-domain>/version
curl -sS https://pukucloud-api-staging.<your-domain>/readyz
```

Then create a token via the dashboard or directly in D1:

```bash
# Mint a token via the dashboard, or use the stub auth path:
curl -sS -X POST https://pukucloud-api-staging.<your-domain>/v1/me/tokens \
  -H 'X-Stub-User: dev' -H 'Content-Type: application/json' \
  -d '{"label":"smoke"}'
```

Create + exec a sandbox to confirm the agent proxy works:

```bash
curl -sS -X POST https://pukucloud-api-staging.<your-domain>/v1/sandboxes \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"template":"base"}'
```

## 2. Backfill R2 with snapshots

Bake fresh snapshots into R2 instead of GCS:

- `templates/<name>/{vm.mem,vmstate,rootfs.ext4}`
- `volumes/<name>/ext4.vol`

You can either:

(a) Re-run `scripts/bake-templates.sh` against an agent that points at R2
    (requires adding the R2 adapter to the agent), or
(b) Mirror the existing GCS bucket to R2 with `rclone sync --http-url
    https://storage.googleapis.com ...` and then flip the agent over.

For step (a) the Go agent code lives at `agent/internal/snapstore/`,
`agent/internal/memstream/`, and `agent/internal/diskstream/`. Add an
`r2` adapter alongside the existing `gcs` adapter (each is a thin
interface: `Head`, `RangeGet`, `Put`).

## 3. Front the db-proxy with Cloudflare Spectrum

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_ZONE_ID=... \
DB_PROXY_HOSTNAME=db.example.com \
DB_PROXY_ORIGIN=<public-ip-of-db-proxy-vm>:5432 \
npx tsx scripts/cf-spectrum.ts
```

`*.db.example.com:5432` now flows through Cloudflare with TLS SNI
preserved, hits the existing db-proxy on the VM, which still does the
WebSocket-upgrade tunnel to the agent fleet.

## 4. Switch the dashboard's API base

`dashboard/.env.local`:

```env
NEXT_PUBLIC_PUKUCLOUD_API=https://pukucloud-api.<your-domain>
```

Re-deploy the dashboard to Cloudflare Pages:

```bash
cd ../dashboard
npm install
npx @cloudflare/next-on-pages
npx wrangler pages deploy .vercel/output/static
```

(Or use the existing `../deploy/deploy-dashboard-cf.sh`.)

## 5. Cutover

1. Run staging for at least a week, watching Cloudflare logs + ClickHouse
   + Grafana.
2. Promote to production:
   ```bash
   npx wrangler deploy --env production
   ```
3. Update the wildcard DNS for `api.example.com` → Cloudflare Worker route.
4. Leave the old Go API running for a 24 h rollback window.
5. After 24 h with no incidents, decommission the Go API.

## 6. Rollback

If something goes wrong:

1. Revert the DNS `api.example.com` to the old Go API origin.
2. Cloudflare Workers keep running, but receive zero traffic — no harm
   done.
3. Investigate via `wrangler tail`.

## 7. After cutover

- The Go API at `../api/` is read-only; you can keep it for reference or
  delete it.
- The agent fleet at `../agent/` continues to run unchanged.
- `agent/internal/{snapstore,memstream,diskstream}/` gain an `r2`
  adapter; `gcs` stays as the default for self-hosters who haven't
  adopted R2.
- The Terraform envs (`infra/terraform/envs/{dev-aws,dev-gcp-multi}/`)
  lose their `compute` API module but keep the agent MIG/ASG, db-proxy
  VM, ClickHouse Cloud binding, and Cloudflare DNS module.

## 8. What this directory does NOT replace

- **Firecracker agents** — still on bare-metal / GCP KVM. Cannot move to
  Cloudflare (no `/dev/kvm`).
- **db-proxy binary** — still on a VM (or could be rewritten as a Worker
  that does the same TLS-handshake + WebSocket-upgrade; tracked in
  followups).
- **ClickHouse** — moved to **ClickHouse Cloud** (managed, S3-backed).
  Set `CLICKHOUSE_URL` accordingly.

## 9. Cost expectations (rough)

- Workers: free tier covers ~100k req/day; paid is $0.30/M + $0.02/M CPU
  ms.
- D1: free 5 GB / day; paid $0.75/GB-mo.
- R2: $0.015/GB-mo + zero egress (the killer feature for UFFD/NBD Range
  GETs).
- KV: $0.50/GB-mo + reads.
- Spectrum: $1/GB processed on `db.example.com`.
- ClickHouse Cloud: production starts ~$50/mo (3-replica minimum on the
  smallest tier).

A modest self-host (10 sandboxes/day, 1 managed DB) should land under
$5/mo of Cloudflare spend; the savings vs running an always-on API VM +
ClickHouse VM usually dominate.

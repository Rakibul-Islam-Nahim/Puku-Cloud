# PukuCloud on Cloudflare Workers

This directory is the Cloudflare-hosted control plane for PukuCloud. It
replaces the Go API at `../api/` with a TypeScript + Hono application that
runs on Cloudflare Workers, with D1 for control-plane state, R2 for
snapshot / seed storage, KV for cache, and the existing Firecracker
agents staying on bare-metal / GCP KVM hosts.

```
clients ──► Cloudflare Workers (this dir)
                │
                ├── D1   (orgs, members, tokens, db registry, snapshots, leases)
                ├── R2   (vm.mem, vmstate, rootfs.ext4, volume ext4 blobs)
                ├── KV   (NAT-ID prewarm cache, JWKS pin)
                └──►   agent fleet (one HTTPS hop per /v1/* request)
                          │
                          └── Firecracker microVMs (stays on KVM)
```

## Layout

```
workers/
├── package.json              ← Hono, jose, zod, nanoid; wrangler, vitest, TS
├── tsconfig.json
├── wrangler.toml             ← Workers + D1 + R2 + KV + per-env overrides
├── vitest.config.ts          ← vitest-pool-workers (runs unit tests in workerd)
├── .gitignore
├── README.md                 ← you are here
├── MIGRATION_TO_CLOUDFLARE.md← step-by-step cutover runbook
├── migrations/               ← D1 SQL migrations (apply with `wrangler d1 migrations`)
│   ├── 0001_orgs_and_members.sql
│   ├── 0002_tokens_and_auth.sql
│   ├── 0003_sandboxes.sql
│   ├── 0004_databases.sql
│   ├── 0005_templates_and_snapshots.sql
│   └── 0006_agents_and_natid.sql
├── scripts/
│   └── cf-spectrum.ts        ← idempotently apply Cloudflare Spectrum config
│                               that fronts db-proxy on *.db.<domain>
└── src/
    ├── index.ts              ← Hono entrypoint + middleware chain
    ├── types/env.ts          ← Bindings + Variables types
    ├── middleware/
    │   ├── requestId.ts      ← X-Request-Id + structured log
    │   ├── cors.ts           ← permissive CORS
    │   └── auth.ts           ← unifiedAuth: pds_* tokens → JWT → stub
    ├── routes/
    │   ├── health.ts         ← /healthz, /readyz, /version
    │   ├── sandboxes.ts      ← POST/GET /v1/sandboxes[/*]
    │   ├── databases.ts      ← /v1/databases[/*]
    │   ├── templates.ts      ← /v1/templates, /v1/templates/build
    │   ├── snapshots.ts      ← /v1/snapshots[/*]
    │   ├── orgs.ts           ← /v1/orgs, /v1/me
    │   ├── tokens.ts         ← /v1/me/tokens
    │   └── internal.ts       ← /v1/internal/{agents,natid,r2/range}
    ├── services/
    │   ├── agentProxy.ts     ← reverse-proxy to agent fleet (multi-node)
    │   ├── r2_snapshots.ts   ← Range-GET resolver (presign + proxy modes)
    │   └── clickhouse.ts     ← JSONEachRow batched sink
    └── util/
        ├── ulid.ts           ← pds_ token minting + sha256
        ├── json.ts           ← JSON + error helpers
        └── agents.ts         ← round-robin agent picker
```

## Local dev

```bash
cd workers
npm install
# 1. Create the D1 database and apply migrations.
npx wrangler d1 create pukucloud-db                # copy the database_id into wrangler.toml
npx wrangler d1 migrations apply pukucloud-db --local
# 2. Create the R2 bucket.
npx wrangler r2 bucket create pukucloud-snapshots
# 3. Run.
npx wrangler dev
```

In another shell, point a local agent at this Worker:

```bash
PUKUCLOUD_AGENT_URL=http://localhost:9090 \
  go run ../api/cmd/api &      # or skip — Workers proxies to a remote agent
```

## Auth

`unifiedAuth` middleware (priority order):

1. **Bearer `pds_*` API token** — D1 lookup by prefix, sha256 hash compare.
2. **Bearer JWT** — verified against `SUPABASE_JWKS_URL` (Supabase Auth).
3. **`PUKUCLOUD_AUTH_MODE=stub`** — accepts `X-Stub-User` header.

Query-string `?access_token=…` is also accepted for WS / EventSource
clients. The DB-broker path (`/v1/databases/{id}/proxy[/...]`) forwards
the in-VM `pds_pg_…` token unchanged — the agent validates it.

## Deploy

```bash
# Required secrets (set once per env).
npx wrangler secret put PUKUCLOUD_AGENT_TOKEN       # shared bearer for agent hops
npx wrangler secret put PUKUCLOUD_ADMIN_TOKEN       # bootstrap admin token (optional)
npx wrangler secret put SUPABASE_JWKS_URL            # e.g. https://<ref>.supabase.co/auth/v1/.well-known/jwks.json
npx wrangler secret put SUPABASE_ISSUER              # e.g. https://<ref>.supabase.co/auth/v1
npx wrangler secret put SUPABASE_AUDIENCE            # e.g. authenticated
npx wrangler secret put CLICKHOUSE_URL               # https://<id>.<region>.clickhouse.cloud:8443
npx wrangler secret put CLICKHOUSE_USER
npx wrangler secret put CLICKHOUSE_PASSWORD
npx wrangler secret put R2_SNAPSHOT_TOKEN            # "accessKey:secretKey" (optional; proxy mode is the fallback)

# Apply migrations to the remote D1.
npx wrangler d1 migrations apply pukucloud-db --remote

# Deploy.
npx wrangler deploy --env production
```

## Cloudflare Spectrum (db-proxy L4 front-door)

The db-proxy in `../db-proxy/` listens on `:5432` and reads TLS SNI to
discover the sandbox id. We front it with **Cloudflare Spectrum** so
`*.db.<your-domain>` flows through Cloudflare's edge while preserving
SNI.

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_ZONE_ID=... \
DB_PROXY_HOSTNAME=db.example.com \
DB_PROXY_ORIGIN=203.0.113.42:5432 \
npx tsx scripts/cf-spectrum.ts
```

## R2 layout

```
pukucloud-snapshots/
  templates/<name>/vm.mem
  templates/<name>/vmstate
  templates/<name>/rootfs.ext4
  snapshots/<sandbox-id>/<snap-id>/vm.mem
  snapshots/<sandbox-id>/<snap-id>/vmstate
  snapshots/<sandbox-id>/<snap-id>/rootfs.ext4
  volumes/<name>/ext4.vol
  health/probe                                ← readiness probe target
```

See `MIGRATION_TO_CLOUDFLARE.md` for the full cutover plan.

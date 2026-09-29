# Repository layout

A guided tour of every top-level directory in the PukuCloud repository: what it owns, what lives inside it, and where to start reading. This is the single source of truth for the repo map; subsystem docs (`infra/README.md`, `workers/README.md`, etc.) dive deeper into specific directories.

## Contents

- [How the repo is organized](#how-the-repo-is-organized)
- [Source code](#source-code)
  - [`api/`](#api)
  - [`agent/`](#agent)
  - [`cmd/pukucloud/`](#cmdpukucloud)
  - [`db-proxy/`](#db-proxy)
  - [`workers/`](#workers)
- [Workloads & user-facing surfaces](#workloads--user-facing-surfaces)
  - [`templates/`](#templates)
  - [`dashboard/`](#dashboard)
  - [`docs-site/`](#docs-site)
  - [`cookbook/`, `examples/`](#cookbook-examples)
- [Deployment & operations](#deployment--operations)
  - [`infra/`](#infra)
  - [`deploy/`](#deploy)
  - [`ansible/`, `cloud-init/`, `lima/`](#ansible-cloud-init-lima)
  - [`scripts/`, `bench/`, `tests/`](#scripts-bench-tests)
- [Brand, license, project meta](#brand-license-project-meta)

---

## How the repo is organized

PukuCloud's repository is organized around three planes:

1. **Source code** — the binaries that make the platform run.
2. **Workloads & user-facing surfaces** — what users actually interact with (templates, dashboard, docs, examples).
3. **Deployment & operations** — everything you need to take the source code and run it somewhere.

Brand assets, license, governance, and contributor docs sit alongside as project meta. The full architecture is in [architecture.md](architecture.md); this document is about **where things live**.

---

## Source code

### `api/`

Self-hosted control-plane REST API, written in Go.

- **Owns:** REST surface for sandboxes, databases, templates, snapshots, volumes, orgs, tokens; the scheduler; Postgres-backed control-plane state; audit + events + metrics emission; OpenAPI spec.
- **Module path:** `github.com/pukucloud/api`
- **Entry point:** `cmd/api/main.go`
- **Start reading:** `cmd/api/main.go` for route registration, then `internal/obs/` for cross-cutting telemetry.
- **Adjacent docs:** none specific; everything routes through `cmd/api/main.go`.

### `agent/`

Per-host Firecracker microVM agent, written in Go.

- **Owns:** Firecracker process supervision, slotstore + lease bookkeeping, UFFD memory streaming (`internal/memstream/`), demand-paged rootfs over NBD (`internal/diskstream/`), OCI registry fetch, snapshot seeds (`internal/seed/`), template snapshots (`internal/sandbox/template_snap.go`), per-VM network namespaces (`internal/netns/`), NAT-ID assignment (`internal/sandbox/natid_prewarm.go`).
- **Module path:** `github.com/pukucloud/agent`
- **Entry point:** `cmd/agent/main.go`
- **Companion binaries:** `cmd/pukucloud-daemon` (long-running VM-side helper), `cmd/pukucloud-init` (template seed bootstrap), `cmd/migrate` (Postgres migrations for the agent's local DB).
- **Start reading:** `cmd/agent/main.go` for boot order, then `internal/sandbox/manager.go` for the slot lifecycle.

### `cmd/pukucloud/`

`pukucloud` command-line client. Stdlib-only Go; builds to a single static binary.

- **Owns:** the user-facing CLI (`pukucloud sandbox create`, `pukucloud auth login`, etc.).
- **Module path:** `github.com/pukucloud/cli`
- **Start reading:** the file tree — there's no `main.go` of meaningful size; the binary is just a dispatch over per-subcommand files.
- **Adjacent doc:** [cmd/pukucloud/README.md](../cmd/pukucloud/README.md).

### `db-proxy/`

Postgres SNI proxy. Fronts `*.db.<zone>` on port 5432 and routes to the right agent based on SNI.

- **Owns:** TLS handshake, SNI extraction, the bidirectional WebSocket tunnel back to the agent that ultimately reaches the in-VM query-broker.
- **Module path:** `github.com/pukucloud/db-proxy`
- **Start reading:** `main.go`, then `startup.sh` for the systemd unit / env-file conventions.
- **Adjacent doc:** the `db-proxy` section of [architecture.md](architecture.md#data-plane).

### `workers/`

Cloudflare Workers control-plane deployment. TypeScript + Hono.

- **Owns:** the entire Workers app — REST routes, D1 migrations, R2 snapshot access, KV cache, agent reverse-proxy, ClickHouse event sink, JWKS auth.
- **Layout:**
  - `src/index.ts` — Hono entrypoint and middleware chain.
  - `src/routes/` — per-resource route handlers (`sandboxes.ts`, `databases.ts`, `templates.ts`, `snapshots.ts`, `orgs.ts`, `tokens.ts`, `health.ts`, `internal.ts`).
  - `src/middleware/` — `requestId.ts`, `cors.ts`, `auth.ts` (the `unifiedAuth` chain: `pds_*` token → JWT → stub).
  - `src/services/` — `agentProxy.ts` (reverse proxy to the agent fleet), `r2_snapshots.ts` (Range GET resolver), `clickhouse.ts` (batched JSONEachRow sink).
  - `migrations/` — D1 SQL migrations (apply with `wrangler d1 migrations apply`).
  - `scripts/cf-spectrum.ts` — idempotent script that fronts `db-proxy` with Cloudflare Spectrum.
- **Start reading:** [workers/README.md](../workers/README.md) and [workers/MIGRATION_TO_CLOUDFLARE.md](../workers/MIGRATION_TO_CLOUDFLARE.md).

---

## Workloads & user-facing surfaces

### `templates/`

microVM template Dockerfiles. Four first-party templates ship:

| Template | Purpose |
| --- | --- |
| `base/` | Ubuntu 24.04 + mise; Node, Python, Go, Bun pre-installed. |
| `code-interpreter/` | Data-science oriented: Jupyter, pandas, scikit-learn, etc. |
| `agent/` | AI-agent oriented: persistent filesystem, MCP tools, LSP-friendly. |
| `postgres-16/` | Managed-Postgres rootfs; includes PgBouncer and the query-broker. |

- **Companion Go binary:** `templates/postgres-16/query-broker/` — the in-VM broker that tunnels `postgres://` traffic back to the agent.
- **Adjacent doc:** [bake-global-templates.md](bake-global-templates.md).

### `dashboard/`

Next.js web dashboard. Lists sandboxes, databases, templates, and surfaces audit + metrics.

- **Layout:** standard Next.js App Router (`src/app/`, `src/components/`, `src/lib/`). Public assets in `public/`.
- **Adjacent doc:** [dashboard/README.md](../dashboard/README.md) (mostly stock Next.js content today).

### `docs-site/`

The deployed documentation site (`docs.<zone>`). Next.js + fumadocs; built from MDX under `docs-site/content/docs/`.

- **Owns:** the user-facing documentation that lives at `docs.pukucloud.ai` (or `docs.<your-domain>`).
- **Adjacent doc:** this `docs/` folder is the GitHub-rendered counterpart — same topics, different render target.

### `cookbook/`, `examples/`

- `cookbook/` — tutorial recipes (Python agent examples, base + code-interpreter demos).
- `examples/` — community Terraform skeletons for AWS, GCP, and Fly single-node deploys.

Start here if you want a runnable starting point.

---

## Deployment & operations

### `infra/`

Terraform for production multi-node fleets.

- **Layout:**
  - `terraform/envs/dev-aws/` — AWS VPC + edge ASG + agent ASG (`*.metal`) + RDS + ClickHouse EC2 + db-proxy + Secrets Manager + Cloudflare DNS.
  - `terraform/envs/dev-gcp-multi/` — GCP equivalent (private VPC + edge MIG + agent MIG + Cloud SQL + ClickHouse VM + db-proxy VM + Secret Manager + Cloudflare DNS).
  - `terraform/modules/` — shared modules: networking, compute, edge MIG/ASG, agent MIG, storage, secrets.
- **Adjacent doc:** [infra/README.md](../infra/README.md) — sizing, costs, env structure.
- **Self-host guides:** [setup-self-host-aws.md](setup-self-host-aws.md), [setup-self-host-gcp.md](setup-self-host-gcp.md).

### `deploy/`

Production deploy scripts and Dockerfiles.

- **Layout:**
  - `deploy.sh`, `deploy-host.sh` — top-level deploy entry points (mostly Terraform wrappers).
  - `deploy-dashboard-cf.sh`, `deploy-docs-cf.sh` — Cloudflare Pages deploys.
  - `deploy-gcp-multi.sh` — full GCP multi-node deploy.
  - `Dockerfile.agent`, `Dockerfile.api` — container images (used by self-host; not used by AWS/GCP fleets, which run on bare metal).
- **Adjacent doc:** [deploy/DEPLOY.md](../deploy/DEPLOY.md) — GCP rolling-update runbook.

### `ansible/`, `cloud-init/`, `lima/`

- `ansible/` — agent install + role playbooks (`roles/{common,agent,agent_env,firecracker}`, `inventory/gcp.yml`, `site.yml`).
- `cloud-init/` — host/guest provisioning scripts invoked by Terraform `user-data`. The Terraform envs reference these.
- `lima/` — Lima YAML (`microvm.yaml`) used by `scripts/mac-local-e2e.sh` to bootstrap the local Apple Silicon dev environment.

### `scripts/`, `bench/`, `tests/`

- `scripts/` — utility shell scripts for end-to-end testing, template baking, local environment bring-up. Most are wired into the `Makefile`.
- `bench/` — boot-time, cold-start, and LSP benchmarks. Outputs land under `bench/cold-start/results/` and `bench/lsp/`.
- `tests/` — minimal; mostly end-to-end smoke tests under `tests/e2e/`.

---

## Brand, license, project meta

| File / dir | Purpose |
| --- | --- |
| `README.md` | Project overview, quickstart, OSS-vs-Cloud comparison. The first thing a visitor reads. |
| `LICENSE`, `LICENSE-HEADER.txt`, `NOTICE` | Apache-2.0 license and attributions. |
| `CONTRIBUTING.md` | How to file issues, propose changes, send PRs. |
| `CODE_OF_CONDUCT.md` | Community standards. |
| `GOVERNANCE.md` | Project governance and decision-making. |
| `SECURITY.md` | How to report a vulnerability. |
| `CHANGELOG.md` | Release notes. |
| `Makefile` | Top-level build / test / deploy shortcuts (`make help` for the full list). |
| `docker-compose.yml`, `docker-compose.dev.yml` | Self-host and local-dev compose files. |
| `.env.local.example` | Template for the API/agent env file. Full reference: [secrets-and-config.md](secrets-and-config.md). |
| `.github/workflows/` | GitHub Actions CI. |
| `logos/` | Brand SVGs. |

---

## See also

- [architecture.md](architecture.md)
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md)
- [setup-self-host-aws.md](setup-self-host-aws.md)
- [setup-self-host-gcp.md](setup-self-host-gcp.md)
- [setup-local-mac.md](setup-local-mac.md)
- [setup-local-linux.md](setup-local-linux.md)
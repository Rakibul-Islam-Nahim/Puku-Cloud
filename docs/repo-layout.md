# Repository layout

A guided tour of every top-level directory in the PukuCloud repository: what it owns, what lives inside it, and where to start reading. This is the single source of truth for the repo map; subsystem docs (`infra/README.md`, `workers/README.md`, etc.) dive deeper into specific directories.

## Contents

- [How the repo is organized](#how-the-repo-is-organized)
- [Source code](#source-code)
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

> The previous Go control plane (`api/`) was removed in Phase 3 of the Temporal/Sentry/D1/DO migration. The control plane is the Cloudflare Worker in `workers/`. ClickHouse was removed in Phase 4; analytics live in the D1 `audit_log` table. See [PLAN.md § Phase 3 / Phase 4](../PLAN.md) and [architecture.md](architecture.md) for the migration story.

---

## Source code

### `agent/`

Per-host Firecracker microVM agent, written in Go.

- **Owns:** Firecracker process supervision, slotstore + lease bookkeeping, UFFD memory streaming (`internal/memstream/`), demand-paged rootfs over NBD (`internal/diskstream/`), OCI registry fetch, snapshot seeds (`internal/seed/`), template snapshots (`internal/sandbox/template_snap.go`), per-VM network namespaces (`internal/netns/`), NAT-ID assignment (`internal/sandbox/natid_prewarm.go`), and the Temporal worker lifecycle (`internal/temporal/`).
- **Module path:** `github.com/pukucloud/agent`
- **Entry point:** `cmd/agent/main.go`
- **Companion binaries:** `cmd/pukucloud-daemon` (long-running VM-side helper), `cmd/pukucloud-init` (template seed bootstrap).
- **Start reading:** `cmd/agent/main.go` for boot order, then `internal/sandbox/manager.go` for the slot lifecycle, then `internal/temporal/worker.go` for Temporal integration.

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
- **Adjacent doc:** the `db-proxy` section of [architecture.md](architecture.md).

### `workers/`

Cloudflare Workers control-plane deployment. TypeScript + Hono.

- **Owns:** the entire Workers app — REST routes, D1 migrations, R2 snapshot access, KV cache, Durable Object for live agent state, Temporal client (workflow starting), Sentry transport.
- **Layout:**
  - `src/index.ts` — Hono entrypoint and middleware chain.
  - `src/routes/` — per-resource route handlers (`sandboxes.ts`, `databases.ts`, `templates.ts`, `snapshots.ts`, `orgs.ts`, `tokens.ts`, `health.ts`, `internal.ts`).
  - `src/middleware/` — `requestId.ts`, `cors.ts`, `auth.ts` (the `unifiedAuth` chain: `pds_*` token → JWT → stub).
  - `src/services/` — `r2_snapshots.ts` (Range GET resolver), `clickhouse.ts` (D1 `audit_log` sink — file name is a legacy artifact), `workerState.ts` (DO accessor).
  - `src/durable_objects/workerState.ts` — the `WorkerStateDO` definition.
  - `migrations/` — D1 SQL migrations (apply with `wrangler d1 migrations apply`).
  - `scripts/cf-spectrum.ts` — idempotent script that fronts `db-proxy` with Cloudflare Spectrum.
- **Start reading:** [workers/README.md](../workers/README.md).

---

## Workloads & user-facing surfaces

### `templates/`

microVM template Dockerfiles. Four first-party templates ship:

| Template | Purpose |
|---|---|
| `base/` | Ubuntu 24.04 + mise; Node, Python, Go, Bun pre-installed. |
| `code-interpreter/` | Data-science oriented: Jupyter, pandas, scikit-learn, etc. |
| `agent/` | AI-agent oriented: persistent filesystem, MCP tools, LSP-friendly. |
| `postgres-16/` | Managed-Postgres rootfs; includes PgBouncer and the query-broker. |

- **Companion Go binary:** `templates/postgres-16/query-broker/` — the in-VM broker that tunnels `postgres://` traffic back to the agent.
- **Adjacent doc:** [bake-global-templates.md](bake-global-templates.md).

### `dashboard/`

Next.js web dashboard. Lists sandboxes, databases, templates, workers, and surfaces the audit log.

- **Layout:** standard Next.js App Router (`src/app/`, `src/components/`, `src/lib/`). Public assets in `public/`.
- **Adjacent doc:** [dashboard/README.md](../dashboard/README.md).

### `docs-site/`

The deployed documentation site (`docs.<zone>`). Next.js + fumadocs; built from MDX under `docs-site/content/docs/`.

- **Owns:** the user-facing documentation that lives at `docs.pukucloud.ai` (or `docs.<your-domain>`).
- **Adjacent doc:** this `docs/` folder is the GitHub-rendered counterpart — same topics, different render target.

### `cookbook/`, `examples/`

- `cookbook/` — tutorial recipes (Python agent examples, base + code-interpreter demos).
- `examples/` — community Terraform skeletons for single-node deploys.

Start here if you want a runnable starting point.

---

## Deployment & operations

### `infra/`

Self-hosted infrastructure pieces.

- **Layout:**
  - `temporal/` — Temporal server (docker-compose) for workflow orchestration. Includes a `docker-compose.prod.yml` overlay with TLS + auth.
  - `sentry/` — Sentry server (docker-compose) for error tracking.
  - `terraform/envs/dev-aws/` — **legacy**: an earlier deploy shape (Go API + RDS + ClickHouse + edge ASG). Kept for reference; not on the supported path.
  - `terraform/envs/dev-gcp-multi/` — **legacy**: the GCP equivalent of the above.
  - `terraform/modules/` — shared modules (legacy, used by the envs above).
- **Adjacent doc:** [infra/README.md](../infra/README.md).
- **Production target:** the Cloudflare Worker control plane documented in [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md). Self-host the Temporal + Sentry stacks from `infra/temporal/` and `infra/sentry/`; run agents on bare-metal hosts.

### `deploy/`

Production deploy scripts and Dockerfiles.

- **Layout:**
  - `deploy-dashboard-cf.sh`, `deploy-docs-cf.sh` — Cloudflare Pages deploys.
  - `Dockerfile.agent` — agent container image (used by some self-hosters).
- **Adjacent doc:** [deploy/DEPLOY.md](../deploy/DEPLOY.md).

### `ansible/`, `cloud-init/`, `lima/`

- `ansible/` — agent install + role playbooks (`roles/{common,agent,agent_env,firecracker}`, `inventory/gcp.yml`, `site.yml`).
- `cloud-init/` — host/guest provisioning scripts invoked by Terraform `user-data` (legacy envs above).
- `lima/` — Lima YAML (`microvm.yaml`) used by the legacy `scripts/mac-local-e2e.sh` to bootstrap a local Apple Silicon dev environment. The current local dev path is described in [setup-local-mac.md](setup-local-mac.md).

### `scripts/`, `bench/`, `tests/`

- `scripts/` — utility shell scripts for end-to-end testing, template baking, local environment bring-up. Most are wired into the `Makefile`.
- `bench/` — boot-time, cold-start, and LSP benchmarks. Outputs land under `bench/cold-start/results/` and `bench/lsp/`.
- `tests/` — minimal; mostly end-to-end smoke tests under `tests/e2e/`.

---

## Brand, license, project meta

| File / dir | Purpose |
|---|---|
| `README.md` | Project overview, quickstart, OSS-vs-Cloud comparison. The first thing a visitor reads. |
| `LICENSE`, `LICENSE-HEADER.txt`, `NOTICE` | Apache-2.0 license and attributions. |
| `CONTRIBUTING.md` | How to file issues, propose changes, send PRs. |
| `CODE_OF_CONDUCT.md` | Community standards. |
| `GOVERNANCE.md` | Project governance and decision-making. |
| `SECURITY.md` | How to report a vulnerability. |
| `CHANGELOG.md` | Release notes. |
| `Makefile` | Top-level build / test / deploy shortcuts (`make help` for the full list). |
| `docker-compose.yml`, `docker-compose.dev.yml` | Self-host and local-dev compose files (mostly for Temporal + Sentry now). |
| `.env.local.example` | Template for the agent env file. Full reference: [secrets-and-config.md](secrets-and-config.md). |
| `.github/workflows/` | GitHub Actions CI. |
| `logos/` | Brand SVGs. |
| `PLAN.md` | The migration plan that got the project from PG+CH to Temporal+Sentry+D1+DO. Kept for posterity. |

---

## See also

- [architecture.md](architecture.md)
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md)
- [setup-local-linux.md](setup-local-linux.md)
- [setup-local-mac.md](setup-local-mac.md)
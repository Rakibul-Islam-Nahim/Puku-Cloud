<div align="center">

<img src="logos/pukucloud-tile.svg" alt="PukuCloud" width="120" />

# PukuCloud

**Disposable Firecracker microVMs and managed PostgreSQL — one control plane, one scheduler, one snapshot pipeline.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.22+-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-Workers-3178C6?logo=typescript&logoColor=white)](https://workers.cloudflare.com)
[![Firecracker](https://img.shields.io/badge/Firecracker-microVM-FF6B35)](https://firecracker-microvm.github.io)
[![Postgres](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)

[Quickstart](#60-second-quickstart) · [Features](#features) · [Architecture](#architecture-at-a-glance) · [Self-host](#self-host) · [Docs](docs/README.md)

</div>

---

## What is PukuCloud?

PukuCloud ships two products on one control plane:

- **Disposable Firecracker microVM sandboxes** — for AI agents and untrusted code. Sub-second boot from baked snapshots, demand-paged memory and rootfs, snapshot/fork trees, full lifecycle (pause, resume, hibernate, TTL).
- **Managed PostgreSQL 16 databases (Beta)** — a real, durable database in its own microVM, with a native `postgres://` URL in seconds, continuous WAL archiving, and restore-based failover onto a healthy host.

Both share the same control plane, scheduler, agent fleet, and snapshot pipeline. See [docs/architecture.md](docs/architecture.md) for the full picture.

---

## 60-second quickstart

```bash
git clone https://github.com/pukucloud/pukucloud
cd pukucloud
bash scripts/mac-local-e2e.sh   # or scripts/linux-local-e2e.sh on Linux/KVM
open http://localhost:3000
```

Create a sandbox from the local API:

```bash
curl -sS http://localhost:8080/v1/sandboxes \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}'
```

Exec a command in it:

```bash
curl -sS http://localhost:8080/v1/sandboxes/<id>/exec \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"uname","args":["-a"]}'
```

> Other paths into the project:
> - Apple Silicon local dev — [docs/setup-local-mac.md](docs/setup-local-mac.md)
> - Linux KVM local dev — [docs/setup-local-linux.md](docs/setup-local-linux.md)
> - Cloudflare control plane — [docs/setup-control-plane-cloudflare.md](docs/setup-control-plane-cloudflare.md)
> - Self-hosted Temporal + Sentry — [docs/setup-temporal-self-host.md](docs/setup-temporal-self-host.md)
> - AWS multi-node — [docs/setup-self-host-aws.md](docs/setup-self-host-aws.md)
> - GCP multi-node — [docs/setup-self-host-gcp.md](docs/setup-self-host-gcp.md)
>
> 🚧 **Deploying?** Read [Before you deploy](#before-you-deploy--replace-the-placeholders) first — every checkout ships with example values that **must** be replaced.

---

## Features

### Sandboxes
- Firecracker microVMs with strong process and kernel isolation.
- Sub-second boot on every create via baked snapshot restore — no warm pool of idle VMs.
- Snapshot anywhere and fork running environments instantly, including fork trees (fork a fork).
- **On-demand UFFD memory streaming** — restore microVMs by paging guest memory lazily from object storage (GCS / R2 Range GETs) instead of downloading the full snapshot up front.
- **Demand-paged rootfs streaming** — the same trick for the disk: the guest's root filesystem is served over an in-kernel NBD device backed by ranged reads, so a cold host never downloads a whole rootfs before booting.
- Full lifecycle: pause, resume, hibernate, wake, TTL expiry, and idle reaping.
- Per-template CPU, RAM, and disk sizing baked into each snapshot.
- Memory admission control, a host-pressure ladder, and CPU tiers so one noisy sandbox can't starve the host.
- Network egress controls and per-sandbox network namespaces for safer code execution.
- Exec, REPL, LSP, MCP, and browser terminal surfaces.

### Managed PostgreSQL (Beta)
- Each database gets its own kernel, `postgres` process, connection pooler, and durable data volume.
- Native `postgres://` URL surfaced via REST within ~30–90 s of create.
- Continuous WAL archiving.
- Restore-to-latest failover onto a healthy host.
- Persistent: the idle reaper never deletes them; only an explicit `DELETE` destroys the data.

### Volumes & templates
- Named persistent ext4 volumes (virtio-blk) — read-write to one sandbox or read-only to many.
- Template-based images: OCI images converted to ext4 roots, plus a build pipeline for your own. Four first-party templates ship in the box: `base`, `code-interpreter`, `agent`, `postgres-16`.

### Operations
- Workflow orchestration via Temporal (self-hosted or Temporal Cloud).
- Error monitoring and tracing via Sentry (self-hosted).
- Durable history in Cloudflare D1; per-agent live state in Cloudflare Durable Objects.
- Bring-your-own auth: stub mode for dev, JWT verification against any JWKS endpoint (e.g. Supabase).

---

## Use it from your code

PukuCloud exposes a token-authenticated REST API. Point any HTTP client at your control plane (Cloudflare Worker URL in production, `http://localhost:8787` for `wrangler dev`) and authenticate with an API token (`pds_…`):

```bash
# In production, set this to your deployed controller URL:
export PUKUCLOUD_API=https://pukucloud-api.<your-account>.workers.dev
export PUKUCLOUD_API_KEY=pds_<your-token>

# For local dev with `wrangler dev` running:
# export PUKUCLOUD_API=http://localhost:8787

# create
SBX=$(curl -sS "$PUKUCLOUD_API/v1/sandboxes" \
  -H "Authorization: Bearer $PUKUCLOUD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}' | jq -r .id)

# exec
curl -sS "$PUKUCLOUD_API/v1/sandboxes/$SBX/exec" \
  -H "Authorization: Bearer $PUKUCLOUD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"uname","args":["-a"]}'

# delete
curl -sS -X DELETE "$PUKUCLOUD_API/v1/sandboxes/$SBX" \
  -H "Authorization: Bearer $PUKUCLOUD_API_KEY"
```

Python and TypeScript SDKs and the `pukucloud` CLI are published separately (`pip install pukucloud`, `npm install @pukucloud/sdk`). In this repo you talk to the platform over the REST API directly.

---

## Architecture at a glance

![Architecture](git-content/ReadmeArchitecture.png)

- **API** — the control plane. Either the self-hosted Go API (`api/`) or the Cloudflare Workers deployment (`workers/`). Same REST surface, same auth, same scheduler.
- **Agents** — one per KVM host. Boot and manage Firecracker microVMs.
- **Snapshots** — every create restores a baked per-template snapshot. UFFD memory streaming and NBD rootfs streaming keep cold hosts fast without downloading whole images up front.

Full architecture (control-plane vs data-plane boundaries, UFFD internals, scheduler design, multi-node topology): **[docs/architecture.md](docs/architecture.md)**.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `api/` | Self-hosted control-plane REST API (Go). |
| `agent/` | Per-host Firecracker microVM agent (Go). |
| `db-proxy/` | SNI-routing Postgres proxy (`*.db.<zone>` → DB microVM). |
| `workers/` | Cloudflare Workers control plane (TypeScript + D1 + R2 + KV). |
| `dashboard/` | Web dashboard (Next.js) — sandboxes, databases, templates. |
| `docs/` | GitHub-rendered documentation. See [docs/README.md](docs/README.md). |
| `docs-site/` | Next.js + fumadocs documentation site (deployed to `docs.<zone>`). |
| `templates/` | microVM template Dockerfiles — `base`, `code-interpreter`, `agent`, `postgres-16`. |
| `infra/` | Terraform for AWS (`envs/dev-aws`) and GCP (`envs/dev-gcp-multi`). |
| `deploy/` | Production deploy scripts and Dockerfiles. |
| `ansible/` | Agent install + role playbooks. |
| `cloud-init/` | Host/guest provisioning scripts used by Terraform user-data. |
| `cmd/pukucloud/` | `pukucloud` CLI (Go, stdlib-only). |
| `cookbook/`, `examples/` | Tutorial recipes and example projects. |
| `logos/`, `scripts/`, `bench/`, `lima/`, `tests/` | Brand assets, dev scripts, benchmarks, Lima VM, E2E tests. |

Full per-directory ownership and reading order: **[docs/repo-layout.md](docs/repo-layout.md)**.

---

## Before you deploy — replace the placeholders

Every PukuCloud checkout ships with the same example values (sentry secret key, agent URLs, dashboard URL, D1/KV IDs, etc.). **None of these will work for your deployment** until you replace them. This section is the master checklist.

If you just want to try things locally, the [60-second quickstart](#60-second-quickstart) above is fine — it uses defaults like `pds_local_dev_token` and `localhost:8080`. For any real deployment (staging, prod, even a private cloud), work through this list.

### 🔴 Must replace before any non-local deploy

| Where | Placeholder | How to get the real value |
|---|---|---|
| `infra/sentry/docker-compose.yml` (× 3) | `REPLACE_WITH_openssl_rand_hex_32` | Run `openssl rand -hex 32` and paste the 64-char hex output. **Same value in all three places.** |
| `docker-compose.yml` (× 3) | `${SENTRY_SECRET_KEY:-REPLACE_WITH_openssl_rand_hex_32}` | Same as above, or set `SENTRY_SECRET_KEY` in your shell env. |
| `docker-compose.dev.yml` (× 2) | `${SENTRY_SECRET_KEY:-REPLACE_WITH_openssl_rand_hex_32}` | Same as above. |
| `workers/wrangler.toml` line 40 | `database_id = "REPLACE_WITH_D1_ID"` | Run `wrangler d1 create pukucloud-db` and paste the returned ID. |
| `workers/wrangler.toml` line 55 | `id = "REPLACE_WITH_KV_ID"` | Run `wrangler kv:namespace create CACHE` and paste the returned ID. |
| `workers/wrangler.toml` line 105 | `database_id = "REPLACE_WITH_STAGING_D1_ID"` | Same as line 40, but for your staging D1 (or delete the `[env.staging]` block if you only deploy once). |
| `workers/wrangler.toml` line 16 | `PUKUCLOUD_AGENT_URLS = "https://agent-1.internal.example.com:9090,..."` | Your real bare-metal hostnames / IPs. Comma-separated. Use `http://` if you don't terminate TLS in front of the agent. |
| `workers/wrangler.toml` line 18 | `PUKUCLOUD_DASHBOARD_URL = "https://dashboard.example.com"` | The public URL where the Next.js dashboard will be served. |
| `workers/wrangler.toml` lines 100-101 | `staging.dashboard.example.com`, `agent-staging.internal.example.com` | Same as above, for your staging env (or remove the staging block). |

### 🟡 Set as environment variables on each bare-metal agent host

These are read by the agent at boot. Set them in your systemd unit, Docker env, or shell before launching the agent:

| Variable | Example value | Notes |
|---|---|---|
| `TEMPORAL_ADDRESS` | `temporal.your-domain.tld:7233` | Address of your (self-hosted) Temporal frontend's gRPC port. |
| `TEMPORAL_NAMESPACE` | `default` | Namespace the agent joins. Match what the controller uses. |
| `TEMPORAL_TASK_QUEUE` | `pukucloud-microvms` | Task queue the agent polls. Match what the controller uses. |
| `SENTRY_DSN` | `https://abc123@sentry.your-domain.tld/1` | From Sentry → Settings → Projects → Client Keys (DSN). |
| `PUKUCLOUD_WORKER_ID` | `host-1` | Unique per agent. Shown in logs and Sentry tags. |
| `PUKUCLOUD_REGION` | `us-east-1` | Your region tag. Used for D1 writes and dashboard grouping. |
| `PUKUCLOUD_ENV` | `production` | One of `production`, `staging`, `development`. |
| `PUKUCLOUD_AGENT_TOKEN` | `<random 32+ char secret>` | Shared with the controller. Generate with `openssl rand -hex 32`. |
| `PUKUCLOUD_ADMIN_TOKEN` | `<random 32+ char secret>` | Bootstrap admin token. Generate with `openssl rand -hex 32`. |

### 🟡 Set as Cloudflare Worker secrets

Run these from the `workers/` directory. Each command prompts you to paste the value:

```bash
cd workers
wrangler secret put TEMPORAL_ADDRESS       # e.g. https://temporal.your-domain.tld:8233
wrangler secret put SENTRY_DSN             # e.g. https://abc123@sentry.your-domain.tld/1
wrangler secret put TEMPORAL_AUTH_TOKEN    # only if you enabled auth on Temporal
wrangler secret put PUKUCLOUD_AGENT_TOKEN  # if you keep the legacy agent proxy path
wrangler secret put PUKUCLOUD_ADMIN_TOKEN  # bootstrap admin token
wrangler secret put SUPABASE_JWKS_URL      # leave blank for stub auth (dev only)
```

Verify with `wrangler secret list`.

### ✅ Verification — did you replace everything?

```bash
# 1. No more example domains in your real configs
grep -rE "example\.com|REPLACE_WITH" workers/wrangler.toml infra/sentry/docker-compose.yml docker-compose.yml
# (should print nothing)

# 2. Cloudflare resources exist
wrangler d1 list                           # shows pukucloud-db
wrangler kv:namespace list                 # shows CACHE

# 3. Secrets are set
wrangler secret list | grep -E "TEMPORAL|SENTRY|TOKEN"

# 4. Agent env is set
ssh your-agent-host "env | grep -E 'TEMPORAL|SENTRY|PUKUCLOUD'"

# 5. D1 migrations are applied
wrangler d1 migrations apply pukucloud-db --remote
```

### Where the placeholders came from

Most `example.com` references in `*.md` files, Terraform examples, and shell-script comments are **just illustrative docs** — they don't affect runtime and don't need to change unless you publish those docs verbatim. The list above is the **runtime-impacting** set.

For Terraform / Ansible / cloud-init placeholders (e.g. `REPLACE_WITH_YOUR_GCS_BUCKET`, `REPLACE_WITH_YOUR_TFSTATE_BUCKET`), see the per-environment setup guides in `docs/setup-self-host-{aws,gcp}.md`.

---

## 15-minute deploy walkthrough (Cloudflare + self-hosted Temporal)

Once the placeholders above are replaced, here's the full deploy flow. Times are rough estimates.

### Step 1 — Bring up Temporal (5 min)

```bash
cd infra/temporal
docker compose up -d
# Wait for "healthy" on pukucloud-temporal
curl -fsS http://localhost:8233/health
# → {"status":"SERVING"}
```

If deploying to a remote host, expose port 7233 (gRPC) and 8233 (HTTP API) behind TLS.

### Step 2 — Bring up Sentry (5 min)

```bash
# Already ran: openssl rand -hex 32 → pasted into docker-compose.yml
cd infra/sentry
docker compose up -d
# Open http://localhost:9000 and complete the bootstrap wizard.
# Create two projects: "pukucloud-controller" (Node) and
# "pukucloud-agent" (Go). Copy each project's DSN.
```

### Step 3 — Set Cloudflare secrets (2 min)

```bash
cd workers
wrangler d1 create pukucloud-db           # copy ID → wrangler.toml
wrangler kv:namespace create CACHE        # copy ID → wrangler.toml

# Edit wrangler.toml: paste D1 ID, KV ID, your real URLs.
# Edit infra/sentry/docker-compose.yml if you haven't yet.

wrangler d1 migrations apply pukucloud-db --remote
wrangler secret put TEMPORAL_ADDRESS      # https://temporal.your-domain.tld:8233
wrangler secret put SENTRY_DSN            # from Step 2
wrangler secret put PUKUCLOUD_ADMIN_TOKEN # openssl rand -hex 32
```

### Step 4 — Deploy the controller (1 min)

```bash
wrangler deploy
# Output ends with: "Published pukucloud-api (X.XX sec)"
# Note your URL: https://pukucloud-api.<account>.workers.dev
```

### Step 5 — Boot an agent on bare-metal (2 min)

On each host with `/dev/kvm`:

```bash
# Install the agent binary
curl -L https://github.com/yourorg/pukucloud/releases/latest/download/agent-linux-amd64 \
  -o /usr/local/bin/agent && chmod +x /usr/local/bin/agent

# /etc/pukucloud/agent.env (sourced by the systemd unit):
cat > /etc/pukucloud/agent.env <<'EOF'
TEMPORAL_ADDRESS=temporal.your-domain.tld:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=pukucloud-microvms
SENTRY_DSN=https://abc123@sentry.your-domain.tld/1
PUKUCLOUD_WORKER_ID=host-1
PUKUCLOUD_REGION=us-east-1
PUKUCLOUD_ENV=production
PUKUCLOUD_AGENT_TOKEN=<paste admin token>
EOF

# /etc/systemd/system/pukucloud-agent.service
cat > /etc/systemd/system/pukucloud-agent.service <<'EOF'
[Unit]
Description=PukuCloud Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/pukucloud/agent.env
ExecStart=/usr/local/bin/agent
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now pukucloud-agent
systemctl status pukucloud-agent
# Look for: "temporal worker registered"
```

### Step 6 — Verify (1 min)

```bash
# Health check on controller
curl -fsS https://pukucloud-api.<account>.workers.dev/healthz

# Trigger a workflow
TOKEN="<paste admin token>"
curl -sS -X POST https://pukucloud-api.<account>.workers.dev/v1/sandboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}' | jq
# → { "id": "vm_<ulid>", "status": "queued" }

# Open Temporal UI at http://temporal.your-domain.tld:8080
# You should see the workflow transition queued → running → completed
# within ~30s.

# Open Sentry at http://sentry.your-domain.tld:9000
# You should see a "LaunchMicroVMWorkflow" transaction with no errors.
```

### Adding more agents

```bash
# On a new bare-metal host, repeat Step 5 with a different PUKUCLOUD_WORKER_ID.
# That's it — Temporal routes new workflows to whichever agent has capacity.
```

### Rolling back

```bash
# Disable new workflows (controller keeps serving but stops starting new ones):
wrangler rollback                                    # revert to previous deploy

# Drain an agent gracefully:
ssh agent-host-1 systemctl stop pukucloud-agent
# In-flight activities drain; pending workflows re-route to other agents.

# Tear down Temporal / Sentry (only if you're sure):
cd infra/temporal && docker compose down -v
cd infra/sentry && docker compose down -v
```

---

## Self-host

| Path | Topology | Doc |
| --- | --- | --- |
| Apple Silicon, local dev | Lima microVM with nested virt | [docs/setup-local-mac.md](docs/setup-local-mac.md) |
| Linux KVM host, local dev | Bare-metal or cloud VM with `/dev/kvm` | [docs/setup-local-linux.md](docs/setup-local-linux.md) |
| Cloudflare-hosted control plane, any agent fleet | Workers + D1 + R2 + KV + Durable Objects + Temporal + Sentry | [docs/setup-control-plane-cloudflare.md](docs/setup-control-plane-cloudflare.md) |
| Self-hosted Temporal + Sentry | Your own Temporal + Sentry instances, Cloudflare control plane | [docs/setup-temporal-self-host.md](docs/setup-temporal-self-host.md) |
| AWS multi-node | VPC + edge ASG + agent ASG (`*.metal`) | [docs/setup-self-host-aws.md](docs/setup-self-host-aws.md) |
| GCP multi-node | Private VPC + edge MIG + agent MIG | [docs/setup-self-host-gcp.md](docs/setup-self-host-gcp.md) |

Single-node community examples live in `examples/terraform/{aws,gcp,fly}/single-node/`.

---

## Open source vs PukuCloud Cloud

This repository is the whole engine, not a demo. Everything in the **Open source** column runs on your own hardware under Apache-2.0, with **no usage limits of any kind** — the OSS edition ships unmetered and uncapped, and contains no billing, metering, quota, or subscription code at all.

**PukuCloud Cloud** is the hosted service run by the PukuCloud team. It runs this same core and adds a small number of features that stay hosted-only, plus the operational work of running a Firecracker fleet.

| | Open source (this repo) | PukuCloud Cloud |
| --- | --- | --- |
| **Sandbox lifecycle** | Full — create, exec, REPL, LSP, terminal, filesystem, pause/resume, hibernate/wake, TTL, idle reaping, delete | Same |
| **Snapshots & fork** | Full — named snapshots, instant fork of a running VM, fork trees, boot-from-snapshot | Same |
| **Memory streaming** | UFFD demand-paged guest memory from object storage | Same |
| **Rootfs streaming** | Demand-paged rootfs over in-kernel NBD | Same |
| **Templates** | Four first-party templates + build your own from any Debian-based OCI image | Same, plus first-party templates kept baked and warm for you |
| **Volumes** | Named persistent ext4 volumes, rw-exclusive / ro-shared | Same |
| **Managed Postgres** | Full — per-database microVM, native `postgres://` URL, REST query broker, continuous WAL archiving, daily base backups, restore-to-latest failover, credential rotation, idle auto-suspend | Same |
| **Database branching** | — | Branch a running database into an independent copy |
| **Point-in-time restore** | Restore to latest (used by failover) | Backup browser, clone-to-new-database, restore to any second in the retention window |
| **Connection hardening** | Direct `postgres://` URL, TLS required | Per-database IP allow lists, rate limits, pooled (PgBouncer) URL |
| **Orchestration** | Temporal workflows + Sentry errors + D1 history + Durable Objects for live state | Same, running across a managed multi-region fleet |
| **Observability** | Audit log, Temporal history, Sentry errors | Same, pre-wired and retained for you |
| **Usage limits** | None. Unmetered, uncapped, no billing code | Plan-based, with support and an SLA |
| **Operations** | You run the KVM hosts, Temporal, Sentry, object storage, upgrades, and backups | Managed fleet, managed upgrades, support |

---

## Roadmap

- [x] Local Apple Silicon developer path with Lima and Firecracker smoke test.
- [x] Managed PostgreSQL 16 databases (Beta) — durable, per-DB microVM, native `postgres://`.
- [x] On-demand UFFD memory streaming — lazily page guest memory from object storage on restore.
- [x] Demand-paged rootfs streaming over an in-kernel NBD device.
- [ ] Read replicas and storage autoscaling for managed databases.
- [ ] Cross-host durability for volumes and databases (object-storage staging on attach).
- [ ] Single-node Linux self-host quickstart.
- [ ] Snapshot store adapters for additional object storage backends.
- [ ] Multi-node scheduler examples for Kubernetes, Nomad, and managed instance groups.
- [ ] 1.0 API stability and steering committee formation.

---

## Limitations & scope

This is the **open-source core** of PukuCloud. A few things to know before you build on it:

- **Hosts must run on bare-metal KVM.** Firecracker needs `/dev/kvm`, so agents run on Linux KVM hosts or `*.metal` cloud instances. On Apple Silicon, local dev runs Firecracker inside a Lima VM via Apple Virtualization.framework (nested virt). There is no Windows/macOS-native host path.
- **No billing or metering.** This cut ships **unmetered and uncapped** — no Stripe, no subscription tiers, no per-workspace sandbox/CPU/quota limits, and no metering code to strip out. Self-hosters run without usage limits; if you need billing, that's a layer you add yourself.
- **Sandboxes and databases only.** Git-driven app hosting, serverless functions, cron schedules, PR preview environments, custom domains, the GitHub App, and managed env-secrets are **not part of this repository**. If you find a stale reference to any of them, it's a bug — please open an issue.
- **Three features are Cloud-only.** Database branching, point-in-time restore with a backup browser and retention policies, and database connection hardening (IP allow lists, connection rate limits, pooled connection URLs) are not in this repo.
- **Auth is bring-your-own.** Ships with a `stub` mode (local dev) and JWT verification against a JWKS endpoint (e.g. Supabase). There's no built-in user database or signup flow — wire it to your own identity provider.
- **Single-tenant-ish by default.** Org/tenancy tables exist, but the access-control model is intentionally minimal. Review it before exposing the API to untrusted users.
- **Managed databases are Beta.** They work, and they are continuously archived — but read replicas, storage autoscaling, and cross-host durability are not here yet. Don't make a single Beta database the only copy of irreplaceable data.
- **Object-storage coupling.** Snapshot seeds, UFFD memory streaming, and rootfs streaming currently assume GCS or R2. Other backends need an adapter (see Roadmap).
- **Deployment is Terraform-first.** Production deploys use the multi-node Terraform envs (`infra/terraform/envs/dev-aws`, `dev-gcp-multi`). The cloud-init / user-data bootstrap scripts are functional scaffolds — review them before a real apply.
- **The dashboard screenshot is an illustration**, not a product screenshot.

---

## Documentation

Start here: **[docs/README.md](docs/README.md)** — the documentation index.

| Topic | Where |
| --- | --- |
| Cloudflare control plane setup | [docs/setup-control-plane-cloudflare.md](docs/setup-control-plane-cloudflare.md) |
| AWS multi-node self-host | [docs/setup-self-host-aws.md](docs/setup-self-host-aws.md) |
| GCP multi-node self-host | [docs/setup-self-host-gcp.md](docs/setup-self-host-gcp.md) |
| Apple Silicon local dev | [docs/setup-local-mac.md](docs/setup-local-mac.md) |
| Linux KVM local dev | [docs/setup-local-linux.md](docs/setup-local-linux.md) |
| Architecture (control / data / workloads) | [docs/architecture.md](docs/architecture.md) |
| Repository layout | [docs/repo-layout.md](docs/repo-layout.md) |
| Baking global templates | [docs/bake-global-templates.md](docs/bake-global-templates.md) |
| Secrets and config reference | [docs/secrets-and-config.md](docs/secrets-and-config.md) |
| Observability | [docs/observability.md](docs/observability.md) |
| Disaster recovery | [docs/disaster-recovery.md](docs/disaster-recovery.md) |

Subsystem-specific docs (also kept up to date):

| Subsystem | Doc |
| --- | --- |
| Infrastructure (Terraform) | [infra/README.md](infra/README.md) |
| GCP rolling-update runbook | [deploy/DEPLOY.md](deploy/DEPLOY.md) |
| Cloudflare Workers | [workers/README.md](workers/README.md) |
| Cloudflare cutover runbook | [workers/MIGRATION_TO_CLOUDFLARE.md](workers/MIGRATION_TO_CLOUDFLARE.md) |
| `pukucloud` CLI | [cmd/pukucloud/README.md](cmd/pukucloud/README.md) |
| Dashboard | [dashboard/README.md](dashboard/README.md) |

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md) before opening a substantial PR. Security issues: [SECURITY.md](SECURITY.md).

---

## License

PukuCloud is licensed under the [Apache License 2.0](LICENSE).

---

## Credits

PukuCloud stands on excellent open-source systems and tools, including Firecracker, Lima, ClickHouse, Next.js, Postgres, Go, TypeScript, Python, Terraform, and the broader Linux virtualization ecosystem. Thank you to the maintainers and communities behind them.
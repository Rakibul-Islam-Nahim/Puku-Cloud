# PukuCloud documentation

This directory contains GitHub-rendered documentation for self-hosting, operating, and contributing to PukuCloud. Start at the path that matches what you're trying to do.

## I want to…

| Goal | Doc |
| --- | --- |
| Run a sandbox on my Mac in 60 seconds | [setup-local-mac.md](setup-local-mac.md) |
| Run a sandbox on a Linux KVM host | [setup-local-linux.md](setup-local-linux.md) |
| Deploy the control plane on Cloudflare Workers | [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) |
| Deploy a multi-node fleet on AWS | [setup-self-host-aws.md](setup-self-host-aws.md) |
| Deploy a multi-node fleet on GCP | [setup-self-host-gcp.md](setup-self-host-gcp.md) |
| Operate a multi-node fleet (add/remove a node, pools, scheduler, leases) | [multi-node.md](multi-node.md) |
| Understand how the pieces fit together | [architecture.md](architecture.md) |
| Find my way around the repo | [repo-layout.md](repo-layout.md) |
| Build or update a global template image | [bake-global-templates.md](bake-global-templates.md) |
| Look up an env var or secret | [secrets-and-config.md](secrets-and-config.md) |
| Wire up ClickHouse / Grafana / OTel | [observability.md](observability.md) |
| Recover from an outage (failover, rollback) | [disaster-recovery.md](disaster-recovery.md) |

## Full doc set

### Setup
- [setup-local-mac.md](setup-local-mac.md) — Apple Silicon, Lima, local dev.
- [setup-local-linux.md](setup-local-linux.md) — Linux host with `/dev/kvm`, local dev.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — control plane on Cloudflare Workers, agents anywhere.
- [setup-self-host-aws.md](setup-self-host-aws.md) — full multi-node fleet on AWS via Terraform.
- [setup-self-host-gcp.md](setup-self-host-gcp.md) — full multi-node fleet on GCP via Terraform.
- [multi-node.md](multi-node.md) — operator walkthrough: agent registration, scheduler, leases, pools, burst-spread, draining a node.

### Concepts & reference
- [architecture.md](architecture.md) — control plane, data plane, workloads; how UFFD streaming, snapshot store, and the scheduler fit together.
- [repo-layout.md](repo-layout.md) — one section per top-level directory; what each owns, who maintains it, where to start reading.
- [secrets-and-config.md](secrets-and-config.md) — every `PUKUCLOUD_*` env var, Cloudflare secret, GCP/AWS secret-manager entry.

### Operations
- [observability.md](observability.md) — ClickHouse, Grafana, OTel, how logs/metrics/events flow.
- [disaster-recovery.md](disaster-recovery.md) — managed-database failover, snapshot replication, rollback.
- [bake-global-templates.md](bake-global-templates.md) — building `base`, `code-interpreter`, `agent`, `postgres-16` and syncing them to every agent.

## Adjacent documentation

These live next to the code they describe and are kept current with each subsystem:

| File | Owns |
| --- | --- |
| [README.md](../README.md) | Project overview, quickstart, OSS vs Cloud. |
| [infra/README.md](../infra/README.md) | Terraform sizing, costs, env structure. |
| [deploy/DEPLOY.md](../deploy/DEPLOY.md) | GCP rolling-update operational runbook. |
| [workers/README.md](../workers/README.md) | Cloudflare Workers control-plane reference. |
| [workers/MIGRATION_TO_CLOUDFLARE.md](../workers/MIGRATION_TO_CLOUDFLARE.md) | Step-by-step cutover from the self-hosted Go API. |
| [cmd/pukucloud/README.md](../cmd/pukucloud/README.md) | `pukucloud` CLI reference. |
| [dashboard/README.md](../dashboard/README.md) | Dashboard dev server / build. |
| [templates/README.md](../templates/README.md) | Template authoring guide. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute. |
| [GOVERNANCE.md](../GOVERNANCE.md) | Project governance. |
| [SECURITY.md](../SECURITY.md) | Reporting vulnerabilities. |

## Documentation conventions

- Each top-level doc owns one topic. Setup guides do not also explain architecture; the architecture document does not also include setup steps.
- Code blocks use language hints (`bash`, `hcl`, `go`).
- Env vars are written as `PUKUCLOUD_*`; secrets use the same name as the runtime expects.
- File paths in tables are relative to the repo root unless noted otherwise.
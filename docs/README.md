# PukuCloud documentation

This directory contains GitHub-rendered documentation for self-hosting, operating, and contributing to PukuCloud. Start at the path that matches what you're trying to do.

## I want to…

| Goal | Doc |
| --- | --- |
| Run a sandbox on my Mac in 60 seconds | [setup-local-mac.md](setup-local-mac.md) |
| Run a sandbox on a Linux KVM host | [setup-local-linux.md](setup-local-linux.md) |
| Deploy the control plane on Cloudflare Workers | [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) |
| Bring up self-hosted Temporal + Sentry | [setup-temporal-self-host.md](setup-temporal-self-host.md) |
| Operate a multi-node fleet (add/remove a node, drain, failure handling) | [multi-node.md](multi-node.md) |
| Understand how the pieces fit together | [architecture.md](architecture.md) |
| Find my way around the repo | [repo-layout.md](repo-layout.md) |
| Build or update a global template image | [bake-global-templates.md](bake-global-templates.md) |
| Look up an env var or secret | [secrets-and-config.md](secrets-and-config.md) |
| Understand the signal model (D1 audit log, DO live state, Temporal, Sentry) | [observability.md](observability.md) |
| Recover from an outage (failover, rollback) | [disaster-recovery.md](disaster-recovery.md) |

## Full doc set

### Setup
- [setup-local-mac.md](setup-local-mac.md) — Apple Silicon, Lima, local dev.
- [setup-local-linux.md](setup-local-linux.md) — Linux host with `/dev/kvm`, local dev.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — control plane on Cloudflare Workers, agents anywhere.
- [setup-temporal-self-host.md](setup-temporal-self-host.md) — bring up Temporal + Sentry via docker-compose.
- [multi-node.md](multi-node.md) — operator walkthrough: agent registration, Temporal routing, drain, failure handling.

### Concepts & reference
- [architecture.md](architecture.md) — full system diagram + per-section diagrams (control plane, request flow, fleet, snapshot pipeline). Single source of truth.
- [repo-layout.md](repo-layout.md) — one section per top-level directory; what each owns, who maintains it, where to start reading.
- [secrets-and-config.md](secrets-and-config.md) — every `PUKUCLOUD_*` env var, Cloudflare secret, Temporal/Sentry env.

### Operations
- [observability.md](observability.md) — D1 `audit_log`, `WorkerStateDO`, Temporal history, Sentry; what flows where and how to read it.
- [disaster-recovery.md](disaster-recovery.md) — managed-database failover, snapshot replication, rollback, secret rotation.
- [bake-global-templates.md](bake-global-templates.md) — building `base`, `code-interpreter`, `agent`, `postgres-16` and syncing them to every agent via R2.

### Runbooks

- [runbooks/temporal-failover.md](runbooks/temporal-failover.md)
- [runbooks/agent-evacuation.md](runbooks/agent-evacuation.md)
- [runbooks/region-loss.md](runbooks/region-loss.md)

## Adjacent documentation

These live next to the code they describe and are kept current with each subsystem:

| File | Owns |
|---|---|
| [README.md](../README.md) | Project overview, run guide, OSS vs Cloud. |
| [infra/README.md](../infra/README.md) | Self-hosted Temporal + Sentry stacks. The legacy `infra/terraform/envs/{dev-aws,dev-gcp-multi}` are reference, not on the supported path. |
| [deploy/DEPLOY.md](../deploy/DEPLOY.md) | Production deploy scripts. |
| [workers/README.md](../workers/README.md) | Cloudflare Workers control-plane reference. |
| [dashboard/README.md](../dashboard/README.md) | Dashboard dev server / build. |
| [templates/README.md](../templates/README.md) | Template authoring guide. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute. |
| [GOVERNANCE.md](../GOVERNANCE.md) | Project governance. |
| [SECURITY.md](../SECURITY.md) | Reporting vulnerabilities. |

## Documentation conventions

- Each top-level doc owns one topic. Setup guides do not also explain architecture; the architecture document does not also include setup steps.
- Diagrams are Mermaid (renders natively on GitHub).
- Code blocks use language hints (`bash`, `hcl`, `go`, `toml`).
- Env vars are written as `PUKUCLOUD_*`; secrets use the same name as the runtime expects.
- File paths in tables are relative to the repo root unless noted otherwise.
# Self-host on AWS (multi-node)

Production-grade, multi-node PukuCloud on AWS via Terraform. This is the largest, most opinionated deploy; for the bare minimum, see [setup-local-linux.md](setup-local-linux.md). For GCP, see [setup-self-host-gcp.md](setup-self-host-gcp.md).

## Contents

- [What you get](#what-you-get)
- [Costs (real numbers)](#costs-real-numbers)
- [Prerequisites](#prerequisites)
- [Step 1 — Choose your footprint](#step-1--choose-your-footprint)
- [Step 2 — Configure Terraform variables](#step-2--configure-terraform-variables)
- [Step 3 — Initialize and apply](#step-3--initialize-and-apply)
- [Step 4 — Verify the deploy](#step-4--verify-the-deploy)
- [Step 5 — Switching to the Cloudflare control plane](#step-5--switching-to-the-cloudflare-control-plane)
- [Operational notes](#operational-notes)

---

## What you get

A `dev-aws` Terraform env provisions the following in one region (us-east-1 by default):

| Component | What | Notes |
| --- | --- | --- |
| VPC | 2 AZs, public + private subnets, NAT gateway | Standard 3-tier layout. |
| Edge ASG | 2 × `m6i.large` running the Go API | Public subnets, behind an ALB. |
| Agent ASG | 2 × `c5n.metal` running the Firecracker agent | Bare-metal because Firecracker needs `/dev/kvm`. |
| RDS for Postgres | `db.m6g.xlarge`, Multi-AZ | Control-plane state, audit, tokens. |
| ClickHouse EC2 | `m6i.xlarge` + 1 TB gp3 | Events and metrics pipeline. |
| db-proxy EC2 | `c6i.large` + EIP | SNI-routing Postgres proxy (`*.db.<zone>`). |
| Secrets Manager | DB DSN, ClickHouse URL, node token, JWKS URL | Read once at boot by every instance. |
| Cloudflare DNS | Edge + db-proxy records | Delegated zone required. |

Shared Terraform modules live under [`infra/terraform/modules/`](../infra/terraform/modules).

---

## Costs (real numbers)

Running a Firecracker fleet is not cheap. The defaults in `variables.tf` are sized for a real fleet with real tenants — roughly **US$7,000/month on AWS list pricing**. Most of that is two bare-metal hosts; there is no way around them.

Every number below is justified in a comment on the matching Terraform variable. The short version of *why* each component is sized the way it is:

- **Agents are big because per-host costs are fixed.** Each agent pre-seeds a baked memory snapshot + base rootfs for every first-party template so a create restores in ~150 ms instead of cold-booting. UFFD memory streaming and the NBD rootfs stream keep a large content-addressed chunk cache on local disk, shared across every sandbox on the host. That overhead is paid once per host regardless of how many sandboxes run on it, so small hosts are strictly worse economics, not a cheaper starting point.
- **The agent's disk holds customer data, not scratch.** Managed-Postgres PGDATA is host-pinned to the agent's durable data volume. Filling that disk is a data incident.
- **Two agents is a floor, not a performance target.** With one agent a managed database has no failover target, and a freshly scaled-out agent is not schedulable until its seed-sync completes.
- **ClickHouse retains the boot events and per-sandbox metrics** behind the dashboard's charts. Retention is time-based, so the disk has to hold the whole window plus merge headroom.

### us-east-1 on-demand list price

| Component | Instance | vCPU | RAM | Disk | Count | ~US$/mo |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| Agent (Firecracker hosts) | `c5n.metal` | 72 | 192 GiB | 1,000 GB gp3 @ 12k IOPS / 500 MB/s | 2 | 5,960 |
| Edge (API + dashboard) | `m6i.large` | 2 | 8 GiB | 100 GB gp3 | 2 | 156 |
| Control-plane DB | `db.m6g.xlarge` (Multi-AZ) | 4 | 16 GiB | 200 GB gp3 | 1 | 612 |
| ClickHouse (analytics) | `m6i.xlarge` | 4 | 16 GiB | 1,000 GB gp3 | 1 | 220 |
| db-proxy (Postgres SNI router) | `c6i.large` | 2 | 4 GiB | 100 GB gp3 | 1 | 70 |
| ALB | — | — | — | — | 1 | 31 |
| NAT gateway | — | — | — | — | 1 | 53 |
| S3 + Secrets Manager + egress | — | — | — | — | — | ~60 |
| **All-in** | | | | | | **≈ 7,160** |

Basis and caveats:

- 730 hours/month, **on-demand list price, no commitment discounts**. A 1-year Compute Savings Plan typically takes 25–30% off the EC2 lines.
- Prices are region- and time-dependent. Confirm with the AWS pricing calculator before you commit.
- Excludes data transfer out to the internet. Sandboxes that stream large artifacts can make egress a top-three line item.
- Excludes anything you would run around the platform (log retention beyond journald, external monitoring, CI runners).

### Shrinking it

These are defaults, not requirements. For an evaluation you can drop to one agent, a single edge instance, `rds_multi_az = false`, and much smaller disks — the stack will come up and work.

| If you set | You lose |
| --- | --- |
| `agent_count = 1` | Managed-database failover (no second host to restore onto) and the ability to drain a host for upgrades. |
| `rds_multi_az = false` | An AZ event freezes all scheduling: no creates, no wakes, no node registration. |
| Smaller `agent_boot_disk_size_gb` | Chunk-cache thrashing. Restores fall back from ~150 ms to a multi-second object-store fetch. Shrink `/opt/pukucloud.img` in `cloud-init/user-data-agent.sh` to match. |
| Smaller `clickhouse_disk_size_gb` | The dashboard's history window, silently, once the disk fills. |
| `use_spot = true` on agents | Reclamation becomes a data-plane event — an evicted agent takes its running sandboxes and host-pinned PGDATA with it. |

---

## Prerequisites

- Terraform >= 1.6.
- AWS credentials: an AWS profile with EC2, VPC, IAM, S3, RDS, Secrets Manager permissions.
- A Cloudflare API token with `Zone:DNS:Edit` on your zone.
- An SSH key pair (`ssh-keygen -t ed25519`).
- The SSH CIDR you'll connect from (no public SSH on any VM; the ASG opens port 22 only for that CIDR).

---

## Step 1 — Choose your footprint

```bash
cd infra/terraform/envs/dev-aws
ls
```

You'll see `main.tf`, `variables.tf`, `terraform.tfvars.example`, `backend.tf`, plus the per-component `*.tf` and `user-data-*.sh.tftpl` templates.

Pick your region and zone by exporting:

```bash
export AWS_REGION=us-east-1
export CLOUDFLARE_ZONE=example.com
```

---

## Step 2 — Configure Terraform variables

```bash
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

Required values:

| Variable | What |
| --- | --- |
| `cloudflare_api_token` | CF API token with `Zone:DNS:Edit` on your zone. |
| `cloudflare_zone_name` | e.g. `example.com`. The edge derives `pukucloud-api.<zone>` and the db-proxy derives `*.db.<zone>` from it. |
| `ssh_pubkey` | Public key content (e.g. `cat ~/.ssh/id_ed25519.pub`). |
| `ssh_allowed_cidr` | CIDR you'll SSH from (e.g. `203.0.113.4/32`). |

Defaults are sized for the production fleet above. For an evaluation, see the "Shrinking it" table.

> Never commit `terraform.tfvars`. It contains secrets. It's already git-ignored.

---

## Step 3 — Initialize and apply

```bash
# State bucket — set your own or wire backend.tf to a remote backend
terraform init -backend-config="bucket=<your-tfstate-bucket>"

terraform plan -out=tfplan.out     # review
terraform apply tfplan.out
```

The Makefile wraps this:

```bash
make tf-aws-plan
make tf-aws-apply
```

Apply takes roughly 10 minutes (RDS is the slowest). After it completes, Terraform prints the public URLs and SSH hints.

---

## Step 4 — Verify the deploy

```bash
# Edge / API health
curl -fsS https://pukucloud-api.<your-domain>/healthz | jq .
# Expected: {"status":"ok","checks":{"PUKUCLOUD_DB_DSN":"ok"}}

# Agent heartbeat (one per agent host)
curl -fsS https://pukucloud-api.<your-domain>/v1/internal/agents | jq .

# Create + exec a sandbox
TOK=$(curl -sS -X POST https://pukucloud-api.<your-domain>/v1/me/tokens \
  -H 'X-Stub-User: dev' -H 'Content-Type: application/json' \
  -d '{"label":"smoke"}' | jq -r .token)

SBX=$(curl -sS -X POST https://pukucloud-api.<your-domain>/v1/sandboxes \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"template":"base"}' | jq -r .id)

curl -sS https://pukucloud-api.<your-domain>/v1/sandboxes/$SBX/exec \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"cmd":"uname","args":["-a"]}'
```

---

## Step 5 — Switching to the Cloudflare control plane

If you want to retire the edge ASG and move the control plane to Cloudflare Workers (the production target):

1. Stand up the Worker first — see [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md). Confirm staging is clean for a week.
2. Update DNS so `pukucloud-api.<zone>` resolves to the Worker route.
3. Decommission the edge ASG (`terraform apply -target=module.edge_asg` to remove just that piece, or set `edge_count = 0` and re-apply).
4. Leave the agent ASG, RDS, ClickHouse, and db-proxy in place — the Worker proxies to the agents, reads from RDS via the agent (RDS still exists), and writes ClickHouse events to ClickHouse Cloud via the Worker's ClickHouse sink.

---

## Operational notes

### Object storage

Object storage is **GCS-only** in the agent today. seed-sync, cross-host snapshot/fork replication, the managed-database WAL archive + failover restore, and UFFD/NBD streaming all speak `gs://`; there is no S3 backend yet. On AWS those stay off (`PUKUCLOUD_GCS_BUCKET` / `PUKUCLOUD_SNAPSHOT_BUCKET` empty): every agent cold-bakes its own template snapshots on first use, forks stay same-host, and a managed database is only as durable as its host's data volume.

Kernels, rootfs templates and binaries do come from the S3 build bucket (`kernels/`, `templates/`, `bin/`, `keys/`).

### Stateful disks in an ASG

Each agent gets a dedicated data volume for customer volumes + PGDATA (`agent_data_disk_size_gb`, kept on termination). When the ASG replaces an instance, the volume is left detached rather than re-attached the way a GCP MIG does. Recovery:

```bash
aws ec2 attach-volume --volume-id <vol-id> --instance-id <new-agent-id> --device /dev/sdf
# Reboot the instance; user-data mounts by label and never reformats a disk
# that already has a filesystem.
```

The ClickHouse data volume behaves the same way.

### Health checks

The agent ASG uses EC2 status checks only (no HTTP autoheal on `:8081/healthz`); the edge ASG is health-checked by the ALB.

### Cloudflare SSL/TLS mode

Set SSL/TLS mode to **Full** for this stack. The edge serves over HTTP behind the Cloudflare proxy; for Full (strict), terminate TLS at the load balancer with a managed/ACM cert.

### db-proxy is a single instance

The db-proxy is a single instance behind a single static IP. It is not on the path for sandboxes or the control plane, but it *is* a single point of failure for customer database connectivity — front two proxies with an NLB if that matters to you.

### Sensitive outputs

`terraform.tfvars`, all `*.tfstate`, and all saved plan files (`*.tfplan`, `tfplan*`, `*.plan`, `*.out`) are git-ignored — never commit them. A saved plan is a serialized copy of the resource graph: it embeds attribute values and the variables that produced them, including ones marked `sensitive`.

---

## See also

- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — recommended production target.
- [setup-self-host-gcp.md](setup-self-host-gcp.md) — same shape on GCP.
- [setup-local-linux.md](setup-local-linux.md) — single-node Linux for development.
- [architecture.md](architecture.md)
- [observability.md](observability.md)
- [disaster-recovery.md](disaster-recovery.md)
- [infra/README.md](../infra/README.md) — Terraform sizing details and shared modules.
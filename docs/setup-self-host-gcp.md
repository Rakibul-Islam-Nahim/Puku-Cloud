# Self-host on GCP (multi-node)

Production-grade, multi-node PukuCloud on GCP via Terraform. Same shape as the AWS env (see [setup-self-host-aws.md](setup-self-host-aws.md)), but on GCP agents don't need bare metal because GCP exposes nested VT-x on `n2-standard-*` instances.

If you only have one machine, see [setup-local-linux.md](setup-local-linux.md). For AWS, see [setup-self-host-aws.md](setup-self-host-aws.md). For Cloudflare-only control plane, see [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md).

## Contents

- [What you get](#what-you-get)
- [Costs](#costs)
- [Prerequisites](#prerequisites)
- [Step 1 — GCP project and APIs](#step-1--gcp-project-and-apis)
- [Step 2 — Configure Terraform variables](#step-2--configure-terraform-variables)
- [Step 3 — Initialize and apply](#step-3--initialize-and-apply)
- [Step 4 — Verify](#step-4--verify)
- [Step 5 — Switching to the Cloudflare control plane](#step-5--switching-to-the-cloudflare-control-plane)
- [Operational notes](#operational-notes)

---

## What you get

A `dev-gcp-multi` Terraform env provisions the following in one region (us-central1 by default):

| Component | What | Notes |
| --- | --- | --- |
| Private VPC | One region, private subnets, Cloud NAT | Public egress via NAT; no public IPs on agents or ClickHouse. |
| Edge MIG | `n2-standard-2` instances running the Go API | Behind a global external HTTPS load balancer. |
| Agent MIG | `n2-standard-64` (64 vCPU / 256 GiB) running the Firecracker agent | Nested VT-x is supported on `n2` — no need for `*.metal`. |
| Cloud SQL | `db-custom-4-16384`, REGIONAL availability | The Cloud SQL equivalent of Multi-AZ. |
| ClickHouse VM | `n2-standard-4` + 1 TB persistent disk | Events and metrics pipeline. |
| db-proxy VM | `n2-standard-2` + static external IP | SNI-routing Postgres proxy. |
| Secret Manager | DB DSN, ClickHouse URL, node token, JWKS URL | Read once at boot. |
| Cloudflare DNS | Edge + db-proxy records | Delegated zone required. |

Shared Terraform modules live under [`infra/terraform/modules/`](../infra/terraform/modules).

---

## Costs

GCP is sized to be comparable to AWS, not identical. On GCP the agent has two disks: an 800 GB boot disk for template preseeds and the streaming chunk cache, and a separate 500 GB **stateful** persistent disk for customer volumes and managed-database PGDATA, which survives a MIG autoheal. Cloud SQL runs `db-custom-4-16384` with `REGIONAL` availability.

All-in cost lands in the same US$6–8k/month band. Run `gcloud compute instances describe` against your own region for exact figures, or use the GCP pricing calculator.

The same "shrinking it" guidance from [setup-self-host-aws.md](setup-self-host-aws.md#costs-real-numbers) applies: dropping to one agent, `ZONAL` Cloud SQL, and smaller disks works for evaluation, but you give up failover and dashboard history.

---

## Prerequisites

- Terraform >= 1.6.
- GCP credentials: `gcloud auth application-default login`.
- A Cloudflare API token with `Zone:DNS:Edit` on your zone.
- An SSH key pair (`ssh-keygen -t ed25519`).

---

## Step 1 — GCP project and APIs

```bash
gcloud auth login
gcloud config set project your-gcp-project

# Enable the APIs the Terraform env uses
gcloud services enable \
  compute.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  dns.googleapis.com \
  servicenetworking.googleapis.com \
  iam.googleapis.com
```

Create a Cloud Storage bucket for Terraform state:

```bash
gsutil mb -l us-central1 gs://your-tfstate-bucket
gsutil versioning set on gs://your-tfstate-bucket
```

---

## Step 2 — Configure Terraform variables

```bash
cd infra/terraform/envs/dev-gcp-multi
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

Required values:

| Variable | What |
| --- | --- |
| `cloudflare_api_token` | CF API token with `Zone:DNS:Edit`. |
| `cloudflare_zone_name` | e.g. `example.com`. |
| `ssh_pubkey` | Public key content. |
| `ssh_allowed_cidr` | CIDR you'll IAP-tunnel from. |

Defaults are sized for the production fleet above.

> Never commit `terraform.tfvars`. It contains secrets. It's already git-ignored.

---

## Step 3 — Initialize and apply

```bash
terraform init -backend-config="bucket=your-tfstate-bucket"

terraform plan -out=tfplan.out
terraform apply tfplan.out
```

The Makefile wraps this:

```bash
make tf-gcp-plan
make tf-gcp-apply
```

Apply takes roughly 8 minutes. After it completes, Terraform prints the public URLs and SSH hints (via IAP).

---

## Step 4 — Verify

```bash
# Edge health
curl -fsS https://pukucloud-api.<your-domain>/healthz | jq .

# Agent status
gcloud compute instance-groups managed list-instances pukucloud-agent-mig \
  --region=us-central1 --format="table(name,currentAction,instanceStatus,version.instanceTemplate.basename())"

# ClickHouse status
gcloud compute instances describe pukucloud-clickhouse-1 --zone=us-central1-a \
  --format="value(status,networkInterfaces[0].networkIP)"
```

For the full sandbox smoke test, see [setup-self-host-aws.md#step-4--verify-the-deploy](setup-self-host-aws.md#step-4--verify-the-deploy).

---

## Step 5 — Switching to the Cloudflare control plane

Same flow as on AWS — see [setup-self-host-aws.md#step-5--switching-to-the-cloudflare-control-plane](setup-self-host-aws.md#step-5--switching-to-the-cloudflare-control-plane). The agent MIG, Cloud SQL, ClickHouse VM, and db-proxy VM stay; only the edge MIG is decommissioned.

---

## Operational notes

### Rolling updates

All infra is managed by Terraform + GCP regional MIGs. Rolling updates are zero-downtime:

- `max_unavailable_fixed = 0` — old instances stay up until new ones are HEALTHY.
- `max_surge_fixed = zones` — GCP spins up new instances first, verifies health, then removes old ones.
- Edge health check: `GET :8080/healthz` — returns 200 when DB connected.
- Agent health check: `GET :8081/healthz`.

### Binary-only update

Build and upload the new binary, then trigger a MIG rolling replace:

```bash
# Build for linux/amd64
(cd api   && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../deploy/.build/bin/pukucloud-api   ./cmd/api)
(cd agent && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../deploy/.build/bin/pukucloud-agent ./cmd/agent)

# Pack and upload edge bundle (api + dashboard)
mkdir -p deploy/.build/dashboard
tar -czf deploy/.build/edge-bundle.tgz -C deploy/.build bin dashboard
gcloud storage cp deploy/.build/edge-bundle.tgz gs://your-builds-bucket/bundles/edge-latest.tgz

# Upload agent binary
gcloud storage cp deploy/.build/bin/pukucloud-agent gs://your-builds-bucket/bin/pukucloud-agent

# Trigger rolling restart — GCP replaces each instance with a fresh boot
gcloud compute instance-groups managed rolling-action replace pukucloud-edge-mig \
  --region=us-central1 --max-unavailable=0 --max-surge=2

# Agents take longer (~15 min each — Firecracker setup)
gcloud compute instance-groups managed rolling-action replace pukucloud-agent-mig \
  --region=us-central1 --max-unavailable=0 --max-surge=2
```

Monitor progress:

```bash
watch -n10 'gcloud compute instance-groups managed list-instances pukucloud-edge-mig \
  --region=us-central1 --format="table(name,currentAction,instanceStatus,version.instanceTemplate.basename())"'
```

### Infra-only update (startup script, metadata, new secrets)

Terraform handles this end-to-end. It creates a new instance template and the MIG auto-rolls:

```bash
terraform plan -out=tfplan.out
terraform apply tfplan.out
```

### Secret update

Secrets live in GCP Secret Manager. Running instances read them **once at boot**, so a secret change requires a rolling restart:

```bash
echo -n "NEW_VALUE" | gcloud secrets versions add pukucloud-database-url --data-file=-

gcloud compute instance-groups managed rolling-action replace pukucloud-edge-mig \
  --region=us-central1 --max-unavailable=0 --max-surge=2
```

The standard secret names:

| Secret | Used by |
| --- | --- |
| `pukucloud-database-url` | Edge + Agent (Postgres DSN) |
| `pukucloud-clickhouse-url` | Edge + Agent (ClickHouse HTTP URL) |
| `pukucloud-node-token` | Edge + Agent (bearer auth between edge↔agent) |
| `pukucloud-supabase-jwks-url` | Edge (JWT verification) |

### Access via IAP

No public SSH on any VM — IAP tunnel only (rarely needed for normal deploys):

```bash
gcloud compute ssh pukucloud-agent-mig-xxxx \
  --zone=us-central1-a --tunnel-through-iap
```

### Dashboard deploy

The dashboard and docs site are Cloudflare Pages, **not** on GCP:

```bash
bash deploy/deploy-dashboard-cf.sh
bash deploy/deploy-docs-cf.sh
```

### Sensitive outputs

Never use `git add -A`. Stage specific files explicitly — a saved terraform plan embeds resource attributes and variable values, including sensitive ones.

---

## See also

- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md)
- [setup-self-host-aws.md](setup-self-host-aws.md)
- [setup-local-linux.md](setup-local-linux.md)
- [architecture.md](architecture.md)
- [deploy/DEPLOY.md](../deploy/DEPLOY.md) — extended operational runbook.
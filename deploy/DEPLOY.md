# PukuCloud Production Deploy Guide

**Project:** `your-gcp-project` (GCP)  
**Topology:** edge MIG (API + dashboard, `us-central1`) + agent MIG (Firecracker, `us-central1`) + ClickHouse VM  
**Terraform state:** `gs://REPLACE_WITH_YOUR_TFSTATE_BUCKET/pukucloud-ai/`  
**Terraform env:** `infra/terraform/envs/dev-gcp-multi/`

> Placeholders in this guide: `your-gcp-project`, `REPLACE_WITH_YOUR_*` and
> `<your-zone>` (your public DNS zone, e.g. `example.com`). MIG-generated
> instance names are shown as `<edge-instance-name>` — read the real ones from
> `gcloud compute instance-groups managed list-instances`.

---

## Prerequisites

```bash
gcloud auth login
gcloud config set project your-gcp-project
```

---

## Rolling updates — how it works

All infra is managed by Terraform + GCP regional MIGs. Rolling updates are zero-downtime:
- `max_unavailable_fixed = 0` — old instances stay up until new ones are HEALTHY
- `max_surge_fixed = zones` — GCP spins up new instances first, verifies health, then removes old ones
- Edge health check: `GET :8080/healthz` — returns 200 when DB connected
- Agent health check: `GET :8081/healthz`

---

## Update 1 — API/agent binary only (no infra change)

**Step 1:** Build and upload the binary:

```bash
# Build for linux/amd64
(cd api   && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../deploy/.build/bin/pukucloud-api   ./cmd/api)
(cd agent && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o ../deploy/.build/bin/pukucloud-agent ./cmd/agent)

# Pack and upload edge bundle (api + dashboard)
mkdir -p deploy/.build/dashboard
tar -czf deploy/.build/edge-bundle.tgz -C deploy/.build bin dashboard
gcloud storage cp deploy/.build/edge-bundle.tgz gs://REPLACE_WITH_YOUR_BUILDS_BUCKET/bundles/edge-latest.tgz

# Upload agent binary separately
gcloud storage cp deploy/.build/bin/pukucloud-agent gs://REPLACE_WITH_YOUR_BUILDS_BUCKET/bin/pukucloud-agent
```

**Step 2:** Trigger rolling restart — GCP replaces each instance with a fresh boot (pulls new binary from GCS):

```bash
# Edge (API) — ~3 min per instance, 0 downtime
gcloud compute instance-groups managed rolling-action replace pukucloud-edge-mig \
  --region=us-central1 --max-unavailable=0 --max-surge=2

# Agent — ~15 min per instance (Firecracker setup)
gcloud compute instance-groups managed rolling-action replace pukucloud-agent-mig \
  --region=us-central1 --max-unavailable=0 --max-surge=2
```

**Monitor:**
```bash
watch -n10 'gcloud compute instance-groups managed list-instances pukucloud-edge-mig \
  --region=us-central1 --format="table(name,currentAction,instanceStatus,version.instanceTemplate.basename())"'
```

---

## Update 2 — Infra change (startup script, metadata, new secrets)

Terraform handles this end-to-end. It creates a new instance template and the MIG auto-rolls.

```bash
cd infra/terraform/envs/dev-gcp-multi
terraform plan -out=tfplan.out   # review changes
terraform apply tfplan.out
```

Terraform will:
1. Create a new instance template (new startup script / metadata)
2. Update the MIG `version.instanceTemplate` → triggers proactive rolling update
3. GCP spins up new instances, waits for `/healthz`, removes old ones

---

## Update 3 — Secret update (DB DSN, tokens, etc.)

Secrets are stored in GCP Secret Manager. Running instances read them **once at boot**. To propagate a secret change:

**Step 1:** Update the secret:
```bash
# Add a new version (old version stays accessible until you destroy it)
echo -n "NEW_VALUE" | gcloud secrets versions add pukucloud-database-url --data-file=-

# Or from file:
gcloud secrets versions add pukucloud-database-url --data-file=./db-url.txt
```

**Available secrets:**
| Secret name | Used by |
|---|---|
| `pukucloud-temporal-address` | Edge + Agent (Temporal HTTP/grpc endpoint) |
| `pukucloud-temporal-auth-token` | Edge + Agent (Temporal bearer, optional) |
| `pukucloud-sentry-dsn` | Edge + Agent (self-hosted Sentry DSN) |
| `pukucloud-node-token` | Edge + Agent (bearer auth between edge↔agent) |
| `pukucloud-supabase-jwks-url` | Edge (JWT verification) |

**Step 2:** Rolling restart to pick up new secret:
```bash
gcloud compute instance-groups managed rolling-action replace pukucloud-edge-mig \
  --region=us-central1 --max-unavailable=0 --max-surge=2
```

---

## Smoke test

```bash
curl -fsS https://api.<your-zone>/healthz | jq .
# Expected: {"status":"ok"}

curl -fsS https://api.<your-zone>/version | jq .
```

---

## Monitor MIG health

```bash
# Backend service health (what the LB sees)
gcloud compute backend-services get-health pukucloud-edge-backend --global

# Instance status
gcloud compute instance-groups managed list-instances pukucloud-edge-mig --region=us-central1
gcloud compute instance-groups managed list-instances pukucloud-agent-mig --region=us-central1

# Serial logs for a specific instance (replace name/zone)
gcloud compute instances get-serial-port-output <edge-instance-name> \
  --zone=<zone> | tail -50
```

---

## Temporal

Temporal runs on a dedicated VM `pukucloud-temporal-1` (us-central1-a, no public IP).
Data is on a persistent disk `pukucloud-temporal-data` — survives VM recreation.
Internal address is auto-written to Secret Manager as `pukucloud-temporal-address`.

```bash
# Check Temporal status
gcloud compute instances describe pukucloud-temporal-1 --zone=us-central1-a \
  --format="value(status,networkInterfaces[0].networkIP)"

# View startup log
gcloud compute instances get-serial-port-output pukucloud-temporal-1 \
  --zone=us-central1-a | grep -E "temporal|schema|bootstrap|error" | tail -20
```

---

## Sentry (self-hosted)

Sentry runs on a dedicated VM `pukucloud-sentry-1` (us-central1-a). It needs its
own Postgres + Redis (those are part of the Sentry terraform stack and are NOT
this project's control-plane state). Internal DSN is auto-written to Secret
Manager as `pukucloud-sentry-dsn`.

```bash
gcloud compute instances describe pukucloud-sentry-1 --zone=us-central1-a \
  --format="value(status,networkInterfaces[0].networkIP)"
```

---

## Dashboard deploy (Cloudflare Pages → `app.<your-zone>`)

Dashboard runs on **Cloudflare Pages** (not the edge VMs).

```bash
bash deploy/deploy-dashboard-cf.sh
```

---

## Docs deploy (Cloudflare Pages → `docs.<your-zone>`)

```bash
bash deploy/deploy-docs-cf.sh
```

---

## Notes

- No public SSH on any VM — IAP tunnel only (but not needed for standard deploys)
- Never use `git add -A`. Stage specific files explicitly — a saved terraform
  plan embeds resource attributes and variable values, including sensitive ones.
- GCS bucket for builds: `REPLACE_WITH_YOUR_BUILDS_BUCKET` (project `your-gcp-project`)
- Terraform state backend: `gs://REPLACE_WITH_YOUR_TFSTATE_BUCKET/pukucloud-ai/`


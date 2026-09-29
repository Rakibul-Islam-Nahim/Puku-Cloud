# Disaster recovery

The runbook for "something broke and I need to recover without losing customer data." Pairs with [observability.md](observability.md) (how to detect breakage) and [architecture.md](architecture.md) (where the data lives).

## Contents

- [Posture](#posture)
- [Failure-mode matrix](#failure-mode-matrix)
- [Managed-Postgres failover](#managed-postgres-failover)
- [Sandbox host loss](#sandbox-host-loss)
- [Control-plane loss](#control-plane-loss)
- [ClickHouse loss](#clickhouse-loss)
- [Secret rotation](#secret-rotation)
- [Snapshot replication](#snapshot-replication)
- [Rollback](#rollback)
- [Data-incident response](#data-incident-response)

---

## Posture

Three things are durable, three are reconstructable:

| | Durable | Reconstructable |
| --- | --- | --- |
| Managed-Postgres PGDATA | Host-pinned to the agent's data volume + WAL archive (GCS / object store) | From base backup + WAL replay, onto a healthy host |
| ClickHouse data | The disk on the ClickHouse VM | None today — see [ClickHouse loss](#clickhouse-loss) |
| API control-plane state (tokens, audit) | RDS for Postgres (Multi-AZ on AWS, REGIONAL on GCP) | None — RDS is the source of truth |
| Sandbox rootfs changes | Forks stay same-host | Cold re-bake from the template preseed on a new host |
| Snapshot store | GCS bucket (cross-host replication lives there on GCP) | From per-host caches, slowly |
| Template preseeds | Per-host, plus GCS seeds on GCP | Rebake via `bake-templates.sh` |

The asymmetry: **managed Postgres is the only line where loss is a customer-data event**. Everything else is compute or analytics.

---

## Failure-mode matrix

| What broke | Customer-visible? | What to do |
| --- | --- | --- |
| One agent host | Some creates fail or land on the other agent; sandboxes on the dead host are gone | Drain (set `DRAINING`), let scheduler re-balance, replace the host |
| Both agent hosts | All creates / wakes fail | Restore from base snapshot or stand up a fresh host |
| Managed-Postgres host | One database down | Restore-to-latest failover onto a healthy agent host |
| Control-plane API | All API calls fail | Workers failover transparently; on self-host, swap ASG/MIG instances |
| ClickHouse VM | Charts empty; nothing else | Restore the volume, or accept the loss window and rebuild |
| RDS for Postgres (control-plane) | Tokens / audit unreachable | Restore from RDS backup or fail over to standby |
| Object store (GCS) | Cross-host snapshot replication broken; WAL archive stuck | Restore bucket, run `gcs-restore-wal` recovery script |
| Secret compromise | Risk of impersonation | Rotate, rolling-restart every consumer |

---

## Managed-Postgres failover

Managed-Postgres databases run inside a Firecracker microVM with a host-pinned data volume. The host-pinning is intentional — the agent pre-seeds the volume and the per-host kernel module for the data volume is part of boot time. To move a database to another host, the agent runs a **restore-to-latest failover**:

1. **Detect host loss** — agent heartbeat drops; the control plane marks the host `DRAINING` and refuses to schedule new databases there.
2. **Pick a healthy target** — scheduler picks a host with enough free RAM + disk and a working `PUKUCLOUD_WAL_URL` relay.
3. **Pull latest base backup + WAL** — the target agent downloads the latest base from the snapshot store and replays WAL from the WAL relay up to the last archived segment.
4. **Update lease** — control plane flips the lease to the new host's PUKUCLOUD_AGENT_ID; subsequent queries go there.
5. **Cut DNS** — the per-database Postgres `host=<id>.db.<zone>` record is updated.

The whole process is in `agent/internal/sandbox/db_restore.go`. Operator-visible triggers:

```bash
# Trigger a manual failover (e.g. you know a host is dying soon)
pukucloud databases failover <database_id> --reason "host imminent"

# Force a failover even if the source looks alive
pukucloud databases failover <database_id> --reason "host-drain" --force
```

RPO is bounded by the WAL archive cadence (default: continuous, max 60 s lag). RTO is base-backup download + WAL replay — typically 30 s to 5 min depending on write volume and WAL retention.

### WAL archive gaps

`pukucloud-wal-archive.sh` exits 1 when the relay is unreachable so postgres retains the segment and retries. To recover from a real gap:

1. Identify the gap: `pukucloud wal-gaps <database_id>` lists missing segments in the archive timeline.
2. If the missing segments are still on the source host's data volume (host not yet garbage-collected), copy them directly via the agent.
3. If the source host is gone, the gap is permanent — promote the next base backup and start from there.

The `wal.env` delivery grace window (15 minutes) prevents an early-boot false-positive: if `wal.env` has not landed, segments are retained, not recycled.

---

## Sandbox host loss

A sandbox's lifecycle is bound to its host. If the host dies, the sandbox is gone. Customers see their `sbx_*` ID return `404` after the reaper sweep.

Operator flow:

1. **Mark the host `DRAINING`.** The scheduler stops placing new sandboxes there; running sandboxes are unaffected until they exit.
2. **Wait for the reaper** (`PUKUCLOUD_REAPER_INTERVAL_SECONDS`, default 30 s) to sweep orphaned leases.
3. **Replace the host.** On AWS, attach the old data volume to the new instance (`aws ec2 attach-volume`); user-data mounts by label and never reformats an existing filesystem. On GCP, the MIG auto-heal creates a new instance and re-attaches the stateful disk automatically.
4. **Re-bake templates.** A new host cold-bakes the template preseed on first use (`PUKUCLOUD_SNAPSHOT_PREFETCH=0`); enable prefetch to warm the cache ahead of time.

`PUKUCLOUD_DATA_DIR=/var/lib/pukucloud` is per-host. Wipe it for a true cold start (`sudo rm -rf /var/lib/pukucloud/*`), but only do this when you intend to re-bake every template.

---

## Control-plane loss

### Workers control plane (production target)

Workers are inherently multi-region. A regional outage degrades the API but does not take it down — Cloudflare's edge routes around the failure. Customers see elevated 5xx rates for the duration of the regional outage.

No operator action; monitor the Cloudflare status page and your `wrangler tail` for the affected region.

### Self-hosted Go API

The control plane runs on Edge ASG/MIG. One instance down is absorbed by the load balancer / MIG. Whole-region loss:

- **AWS:** Failover to the other region is not automated today. Spin up `dev-aws` in a secondary region with a separate state bucket and migrate the DNS record.
- **GCP:** Same as AWS — no built-in cross-region failover. The Terraform env is single-region by design.

RDS Multi-AZ (AWS) / Cloud SQL REGIONAL (GCP) keeps the API's own state alive across an AZ event; the API tier can be brought back in the surviving AZ or region.

### db-proxy loss

Single instance on both AWS and GCP. It is on the path for customer database connections but **not** for the control plane. If it dies, customer `postgres://` connections fail; the dashboard and the API still work.

Front it with an NLB if you care; the Terraform env does not provision one today.

---

## ClickHouse loss

The dashboard charts go empty; nothing customer-facing breaks. Three options:

1. **Restore the volume** if you have a backup. ClickHouse on this stack is a single-node instance; backups are operator-managed (e.g. `clickhouse-backup` to the same GCS bucket the agent uses).
2. **Accept the window.** Analytics restart from a clean ClickHouse; historical charts are blank for the lost period.
3. **Point at ClickHouse Cloud.** Workers and the API both speak `JSONEachRow` over HTTPS, so a URL change in the secrets manager (or `wrangler secret put`) is the only migration. Schema bootstrap runs on the first API start against the new URL.

If you choose (3), the same Workers continue writing; the same dashboard reads. There is no ETL.

---

## Secret rotation

Every secret has a single owner and a single rotation procedure:

| Secret | Where | Rotation |
| --- | --- | --- |
| `pukucloud-database-url` | GCP Secret Manager / AWS Secrets Manager | `gcloud secrets versions add` / `aws secretsmanager put-secret-value`, then **rolling restart** of every edge and agent instance. Running instances read once at boot. |
| `pukucloud-clickhouse-url` | Same | Same. |
| `pukucloud-node-token` | Same | Rotate + rolling restart. **Out-of-sync node tokens are the most common cause of "agent looks healthy but won't accept requests".** |
| `pukucloud-supabase-jwks-url` | Same | JWKS is fetched live by the API; rolling restart not strictly required, but the change is not retroactive for already-validated JWTs. |
| `PUKUCLOUD_AGENT_TOKEN` | Workers secrets / env | `wrangler secret put PUKUCLOUD_AGENT_TOKEN`. The next Worker deploy reads it. |
| `PUKUCLOUD_ADMIN_TOKEN` | Same | Same. |
| ClickHouse Cloud `CLICKHOUSE_PASSWORD` | Workers secrets | Same. |

Operators are explicitly warned in [secrets-and-config.md](secrets-and-config.md): **instances read secrets once at boot, so a secret change requires a rolling restart**. There is no live-reload path.

---

## Snapshot replication

Snapshot replication lives in two places:

1. **Template preseeds.** Per-host cache at `/var/lib/pukucloud/templates/`. On GCP, the agent also seeds from `gs://<bucket>/templates/` on first use. On AWS, this is per-host only — there is no S3 seed path today.
2. **Cross-host sandbox forks.** A forked sandbox's snapshot lives on the source host's data volume. To replicate cross-host, the agent would need to upload to the snapshot bucket and the target host would need to download — both code paths exist (`PUKUCLOUD_SNAPSHOT_BUCKET`) but **are not enabled on AWS today** (only GCS).

Implication for DR:

- **GCP:** A lost host can be rehydrated from `gs://` for templates, and a managed-Postgres failover restores from the latest base + WAL.
- **AWS:** A lost host re-bakes templates from scratch. Managed-Postgres failover still works (it goes through the host-pinned data volume's snapshot on S3 via the managed-Postgres backup path).

The "Object storage is GCS-only" note in [setup-self-host-aws.md](setup-self-host-aws.md#object-storage) is the canonical statement.

---

## Rollback

### Worker control plane

1. Identify the bad deploy: `wrangler deployments list --env production` shows timestamps and traffic.
2. Roll back: `wrangler deployments rollback <deployment-id> --env production`. This is instantaneous and Cloudflare keeps the previous version warm.
3. Verify: `wrangler tail --env production`, watch for the error signature you saw before the rollback.

### Self-hosted API

1. Build the previous tag: `git checkout vX.Y.Z && make api`.
2. Upload: `gcloud storage cp deploy/.build/bin/pukucloud-api gs://your-builds-bucket/bin/pukucloud-api-prev` (or S3 equivalent).
3. Replace on each instance: `gcloud compute instance-groups managed rolling-action replace pukucloud-edge-mig --region=us-central1 --max-unavailable=0 --max-surge=2`. Same for the agent MIG (slower — Firecracker setup).
4. If the rollback touches the **API + agent** protocol, both must be on the same version. There is no mixed-version tolerance.

### Terraform

Terraform state is the source of truth. To revert infra changes:

- **Without applying forward:** `terraform plan -destroy` against the bad resource, or `terraform apply -target=module.<bad>` to revert just that piece.
- **Never** `terraform state push` over a saved plan you don't fully understand. A saved plan embeds attribute values, including sensitive ones — see the warning in [setup-self-host-aws.md](setup-self-host-aws.md#sensitive-outputs).

---

## Data-incident response

The "disk full" / "data corruption" cases. These are not normal operations.

### Managed-Postgres data volume full

- Host-pinned volume is sized for the workload, but unbounded growth is possible (un-vacuumed tables, runaway logs).
- `pukucloud databases inspect <id>` shows disk usage, last vacuum, active connections.
- `pukucloud databases vacuum <id>` runs a full VACUUM in place.
- If the volume is past 95 %, the agent refuses new connections and triggers an auto-suspend on idle databases (per `PUKUCLOUD_DB_IDLE_AFTER_SECONDS`). The volume does not auto-grow on this stack.

### ClickHouse disk full

- `clickhouse-server` fails inserts with `NO_SPACE_LEFT_ON_DEVICE`.
- The mitigation is operational: drop old partitions (`ALTER TABLE ... DROP PARTITION`), shrink retention, or grow the volume.
- This is why the Terraform sizing notes ("`clickhouse_disk_size_gb`") matter — see [setup-self-host-aws.md](setup-self-host-aws.md#shrinking-it).

### Object store loss

- If the GCS bucket holding template seeds is deleted, every host re-bakes from scratch on next use (slow).
- If the bucket holding managed-Postgres WAL archive is deleted, every active database that has not yet taken a new base backup is at risk. The agent falls back to **local WAL retention** for as long as the data volume has space — the script's behavior (`pukucloud-wal-archive.sh`) is to retain and retry.

---

## See also

- [architecture.md](architecture.md) — where the data lives.
- [observability.md](observability.md) — how to detect breakage.
- [secrets-and-config.md](secrets-and-config.md) — secret rotation procedure.
- [setup-self-host-aws.md](setup-self-host-aws.md) / [setup-self-host-gcp.md](setup-self-host-gcp.md) — operational runbooks.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — Workers rollback via `wrangler deployments rollback`.

# Local development on Linux (KVM host)

Run PukuCloud end-to-end on a Linux host that has `/dev/kvm` exposed — bare metal, a `*.metal` cloud instance, or a nested-virt-enabled VM. Firecracker runs natively; no Lima, no nested virtualization layer.

For Apple Silicon, see [setup-local-mac.md](setup-local-mac.md). For multi-node cloud deploys, see [setup-self-host-aws.md](setup-self-host-aws.md) or [setup-self-host-gcp.md](setup-self-host-gcp.md).

## Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Step 1 — One-shot bring-up](#step-1--one-shot-bring-up)
- [Step 2 — Smoke test](#step-2--smoke-test)
- [Step 3 — Running multiple instances](#step-running-multiple-instances)
- [Step 4 — Tear down](#step-4--tear-down)
- [Known limitations](#known-limitations)

---

## What you get

After the one-shot script finishes:

- The Go API (`pukucloud-api`) and the Firecracker agent (`pukucloud-agent`) installed as systemd units on the host.
- The Next.js dashboard dev server running on `http://localhost:3000`.
- A stub auth user (`dev`) and a dev API token (`pds_local_dev_token`).

Sandbox create/exec/delete works end-to-end against the local agent. The first create cold-bakes a template snapshot from the OCI image — expect ~20 s on a cold cache.

---

## Prerequisites

- Linux kernel >= 5.10.
- `/dev/kvm` readable by your user (or run the script as root).
- ~10 GB of free disk (template cache + per-VM rootfs).
- Outbound HTTPS (for the OCI image pulls and for `apt`/`dnf` deps).
- Node.js 22.x (for the dashboard).

Verify KVM is exposed:

```bash
ls -la /dev/kvm
# crw-rw---- 1 root kvm 10, 232 Sep 29 12:00 /dev/kvm

# If your user isn't in the kvm group:
sudo usermod -aG kvm $USER
# Then log out and back in.
```

---

## Step 1 — One-shot bring-up

```bash
git clone https://github.com/pukucloud/pukucloud
cd pukucloud-ai
bash scripts/linux-local-e2e.sh
```

The script will:

1. Install OS-level dependencies (Firecracker, Go if missing).
2. Build the API and agent binaries.
3. Install them as systemd units and start them.
4. Install dashboard dependencies and start the Next.js dev server on the host.
5. Run a final smoke test (create a sandbox from the `base` template and exec `echo hello`).

Open the dashboard:

```bash
open http://localhost:3000      # if you have xdg-open
xdg-open http://localhost:3000
```

---

## Step 2 — Smoke test

```bash
# Create a sandbox
curl -sS http://localhost:8080/v1/sandboxes \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}'

# Exec a command (substitute <id>)
curl -sS http://localhost:8080/v1/sandboxes/<id>/exec \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"echo","args":["hello"]}'

# Delete
curl -sS -X DELETE http://localhost:8080/v1/sandboxes/<id> \
  -H 'Authorization: Bearer pds_local_dev_token'
```

---

## Step 3 — Running multiple instances

A single host can run multiple PukuCloud agents (each in its own network namespace) — useful for testing failover locally.

```bash
# Start a second agent on port 9091
pukucloud-agent --listen :9091 --data-dir /var/lib/pukucloud-agent-2 &

# Register it with the API
curl -sS -X POST http://localhost:8080/v1/internal/agents \
  -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:9091"}'

# Now creates will round-robin across the two agents
```

For production multi-node, you want a real fleet on real hosts — see [setup-self-host-aws.md](setup-self-host-aws.md).

---

## Step 4 — Tear down

```bash
# Stop the systemd services
sudo systemctl stop pukucloud-api pukucloud-agent

# Remove the services entirely
bash scripts/linux-local-e2e-down.sh
```

The dashboard dev server runs in your shell; stop it with Ctrl-C (or `pkill -f "next dev"`).

---

## Known limitations

- **Single-host local dev.** This script runs one agent. Multi-node scheduling and failover need a cloud deploy.
- **Speed.** First sandbox create cold-bakes a template snapshot. ~20 s cold; ~150 ms warm.
- **Storage.** The agent's `/var/lib/pukucloud` holds the chunk cache, template preseeds, and (for managed Postgres) PGDATA. It grows but does not shrink. Wipe it with `sudo rm -rf /var/lib/pukucloud/*` if you want a cold cache.
- **No TLS.** Local dev serves the API over plain HTTP. Don't expose it to the network without putting a reverse proxy in front.
- **Stub auth.** Default mode is `PUKUCLOUD_AUTH_MODE=stub`, which accepts any `X-Stub-User` header. Switch to JWT (Supabase JWKS) before exposing the API — see [secrets-and-config.md](secrets-and-config.md).

---

## See also

- [setup-local-mac.md](setup-local-mac.md) — Apple Silicon alternative.
- [setup-self-host-aws.md](setup-self-host-aws.md) — production AWS.
- [setup-self-host-gcp.md](setup-self-host-gcp.md) — production GCP.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — replace local API with Workers.
- [architecture.md](architecture.md) — what's running on the host.
- [repo-layout.md](repo-layout.md) — what each directory owns.
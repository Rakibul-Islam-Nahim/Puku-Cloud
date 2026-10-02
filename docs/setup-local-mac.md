# Local development on Apple Silicon

Run PukuCloud end-to-end on a Mac with an Apple Silicon (M1/M2/M3/M4) chip. Lima boots a Linux microVM that exposes `/dev/kvm` via Apple Virtualization.framework's nested virtualization, then Firecracker runs inside it. Temporal + Sentry + the controller (Worker) all run on the host.

For Linux on a KVM host, see [setup-local-linux.md](setup-local-linux.md). For production deploys, see [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md).

## Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Step 1 — One-shot bring-up](#step-1--one-shot-bring-up)
- [Step 2 — Smoke test](#step-2--smoke-test)
- [Step 3 — What to look at](#step-3--what-to-look-at)
- [Step 4 — Tear down](#step-4--tear-down)
- [Known limitations](#known-limitations)

---

## What you get

After the steps below finish:

- **Temporal** + its Postgres, in docker-compose on the host (workflow orchestration).
- **Sentry** + its Postgres + Redis, in docker-compose on the host (errors + traces).
- **One Firecracker agent** running inside a Lima microVM. The agent is a Temporal worker — it joins the `pukucloud-microvms` task queue.
- **The Cloudflare Worker control plane** running locally via `wrangler dev` on `http://localhost:8787`.
- **The Next.js dashboard** dev server running on `http://localhost:3000`.
- A stub auth user (`dev`) and a dev API token (`pds_local_dev_token`).

Sandbox create / exec / delete works end-to-end against the in-microVM agent. The first create cold-bakes a template snapshot from the OCI image — expect ~30 s on a cold cache.

---

## Prerequisites

- macOS 13 or newer on Apple Silicon.
- Homebrew.
- ~10 GB of free disk (Lima VM + template cache + Temporal's Postgres).
- Outbound HTTPS (for OCI image pulls).
- Docker + Docker Compose v2 (OrbStack works too).
- `node` 22.x (Worker + dashboard), `go` 1.22+ (agent).

Lima installs if missing:

```bash
brew install lima
```

---

## Step 1 — One-shot bring-up

```bash
git clone https://github.com/pukucloud/pukucloud
cd pukucloud
```

### 1a. Boot the Lima VM with `/dev/kvm`

```bash
# Use the project's lima.yaml if present; otherwise create a minimal one.
limactl start --name=pukucloud lima/microvm.yaml
limactl shell pukucloud -- ls -la /dev/kvm
# Expect: crw-rw---- 1 root kvm ...
```

### 1b. Bring up Temporal + Sentry on the host

```bash
docker compose -f docker-compose.dev.yml up -d temporal sentry
```

The agent runs inside the Lima VM, so you do NOT start it via docker-compose here. Skip the `agent` service.

### 1c. Bootstrap Sentry (one-time)

```bash
# open http://localhost:9000 and finish the bootstrap wizard
# create two projects:
#   - "pukucloud-controller" (Node)
#   - "pukucloud-agent"      (Go)
# copy each project's DSN
```

### 1d. Configure the Worker

```bash
cat > workers/.dev.vars <<EOF
PUKUCLOUD_AGENT_TOKEN=pds_local_dev_token
PUKUCLOUD_ADMIN_TOKEN=pds_local_dev_token
SENTRY_DSN=<paste controller DSN>
TEMPORAL_ADDRESS=http://localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=pukucloud-microvms
AUTH_MODE=stub
EOF

cd workers
npx wrangler d1 migrations apply pukucloud-db --local
npx wrangler dev
```

The Worker now talks to Temporal on the host. Temporal routes activities to the agent, which is also polling Temporal from inside the Lima VM.

### 1e. Run the agent inside the Lima VM

```bash
# Inside the Lima VM:
limactl shell pukucloud -- bash -lc '
  sudo apt-get install -y golang-go || true
  cd /workspace/agent
  go build -o /tmp/pukucloud-agent ./cmd/agent
  sudo install -m 0755 /tmp/pukucloud-agent /usr/local/bin/pukucloud-agent
  cat > /etc/pukucloud/agent.env <<EOF
TEMPORAL_ADDRESS=host.lima.internal:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=pukucloud-microvms
SENTRY_DSN=<paste agent DSN>
PUKUCLOUD_WORKER_ID=host-m1
PUKUCLOUD_REGION=local
PUKUCLOUD_ENV=development
PUKUCLOUD_CONTROLLER_URL=http://host.lima.internal:8787
PUKUCLOUD_AGENT_TOKEN=pds_local_dev_token
EOF
  sudo /usr/local/bin/pukucloud-agent
'
```

Within ~30 s the agent re-subscribes to the Temporal task queue and begins heartbeating to the controller.

### 1f. Run the dashboard

```bash
cd ../dashboard
npm install
echo 'NEXT_PUBLIC_PUKUCLOUD_API=http://localhost:8787' > .env.local
NEXT_PUBLIC_PUKUCLOUD_AUTH=token \
  NEXT_PUBLIC_PUKUCLOUD_ENV=local \
  npm run dev
# Open http://localhost:3000
```

---

## Step 2 — Smoke test

```bash
# Create a sandbox
curl -sS http://localhost:8787/v1/sandboxes \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}'

# Exec a command (substitute <id>)
curl -sS http://localhost:8787/v1/sandboxes/<id>/exec \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"echo","args":["hello"]}'

# Delete
curl -sS -X DELETE http://localhost:8787/v1/sandboxes/<id> \
  -H 'Authorization: Bearer pds_local_dev_token'
```

The Temporal UI is at `http://localhost:8080` if you started it with `docker compose --profile ui up -d`.

---

## Step 3 — What to look at

| Thing | Where |
|---|---|
| Lima VM console | `limactl shell pukucloud` |
| Agent logs (inside VM) | `limactl shell pukucloud journalctl -u pukucloud-agent -f` (or just the stdout if you ran it in the foreground) |
| Controller logs (host) | The terminal where `wrangler dev` is running |
| Temporal UI | `http://localhost:8080` |
| Sentry UI | `http://localhost:9000` |
| Dashboard | `http://localhost:3000` |
| Controller base URL | `http://localhost:8787` |

---

## Step 4 — Tear down

```bash
# Stop the docker-compose stack
docker compose -f docker-compose.dev.yml down -v

# Stop the Worker and dashboard (Ctrl-C in their terminals)

# Stop the Lima VM but keep its data
limactl stop pukucloud

# Delete everything
limactl delete -f pukucloud
```

---

## Known limitations

- **Speed.** First sandbox create cold-bakes a template snapshot. ~30 s cold; ~150 ms once warm.
- **Memory.** The default Lima VM is sized for comfortable dev work; if you raise template CPU/RAM you'll need to grow the VM (`lima/microvm.yaml`).
- **Network.** The VM uses macNAT; sandboxes can reach the internet but their egress appears from your Mac's IP. Egress controls work but observability is your home router.
- **Storage.** The agent's `/var/lib/pukucloud` lives inside the Lima VM's qcow2 image. It grows but does not shrink. `limactl start --rebuild` resets it.
- **ARM only.** This path uses Apple Virtualization.framework, which is Apple Silicon only. Intel Macs need a different setup (or run PukuCloud on a remote Linux KVM host and point the local dashboard at it).
- **One agent.** The local dev env runs a single agent. Multi-node scheduling and failover need a cloud deploy.

---

## See also

- [setup-local-linux.md](setup-local-linux.md) — native Linux KVM path.
- [architecture.md](architecture.md) — what's actually running inside the VM.
- [repo-layout.md](repo-layout.md) — what each directory owns.
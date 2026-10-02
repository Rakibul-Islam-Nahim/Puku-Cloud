# Local development on Linux (KVM host)

Run PukuCloud end-to-end on a Linux host that has `/dev/kvm` exposed — bare metal, a `*.metal` cloud instance, or a nested-virt-enabled VM. Firecracker runs natively; no Lima, no nested virtualization layer.

For Apple Silicon, see [setup-local-mac.md](setup-local-mac.md). For production deploys, see [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md).

## Contents

- [What you get](#what-you-get)
- [Prerequisites](#prerequisites)
- [Step 1 — One-shot bring-up](#step-1--one-shot-bring-up)
- [Step 2 — Smoke test](#step-2--smoke-test)
- [Step 3 — Running multiple agents](#step-3--running-multiple-agents)
- [Step 4 — Tear down](#step-4--tear-down)
- [Known limitations](#known-limitations)

---

## What you get

After the one-shot script finishes:

- **Temporal** + its Postgres, running in docker-compose (workflow orchestration).
- **Sentry** + its Postgres + Redis, running in docker-compose (errors + traces).
- **One Firecracker agent** as a container on this host, with `/dev/kvm` passed in. The agent is a Temporal worker — it joins the `pukucloud-microvms` task queue.
- **The Cloudflare Worker control plane** running locally via `wrangler dev` (Hono + TypeScript on `:8087` or `:8787`, depending on your wrangler version). Stub auth is on by default.
- **The Next.js dashboard** dev server running on `http://localhost:3000`. It talks to the local `wrangler dev` Worker.
- A stub auth user (`dev`) and a dev API token (`pds_local_dev_token`).

Sandbox create / exec / delete works end-to-end against the local agent. The first create cold-bakes a template snapshot from the OCI image — expect ~20 s on a cold cache.

---

## Prerequisites

- Linux kernel >= 5.10.
- `/dev/kvm` readable by your user (or run docker as root / with `--privileged`).
- ~10 GB of free disk (template cache + per-VM rootfs + Temporal's Postgres).
- Outbound HTTPS (for OCI image pulls).
- Docker + Docker Compose v2.
- `node` 22.x (for the Worker and dashboard).
- `go` 1.22+ (for the agent binary, only needed if you want to build it from source).

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
cd pukucloud
```

### 1a. Bring up Temporal + Sentry + agent (docker-compose)

```bash
docker compose -f docker-compose.dev.yml up -d
docker compose -f docker-compose.dev.yml ps
# Expect:
#   pukucloud-temporal            healthy
#   pukucloud-temporal-postgres   healthy
#   pukucloud-sentry              healthy
#   pukucloud-sentry-postgres     healthy
#   pukucloud-sentry-redis        healthy
#   pukucloud-agent               running
```

### 1b. Bootstrap Sentry (one-time)

```bash
# open http://localhost:9000 and finish the bootstrap wizard
# create two projects:
#   - "pukucloud-controller" (Node)
#   - "pukucloud-agent"      (Go)
# copy each project's DSN
```

Put the controller's DSN into `workers/.dev.vars`:

```bash
cat > workers/.dev.vars <<EOF
PUKUCLOUD_AGENT_TOKEN=pds_local_dev_token
PUKUCLOUD_ADMIN_TOKEN=pds_local_dev_token
SENTRY_DSN=https://abc123@sentry.local/1
TEMPORAL_ADDRESS=http://localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=pukucloud-microvms
AUTH_MODE=stub
```

Put the agent's DSN into the agent container's env:

```bash
docker compose -f docker-compose.dev.yml set \
  -f docker-compose.dev.yml environment agent \
  SENTRY_DSN=https://def456@sentry.local/1
docker compose -f docker-compose.dev.yml up -d agent
```

### 1c. Run the controller (Cloudflare Worker) locally

```bash
cd workers
# Apply migrations to the bundled SQLite-backed D1 (local dev only).
npx wrangler d1 migrations apply pukucloud-db --local
npx wrangler dev
# Output ends with something like: "Ready on http://localhost:8787"
```

The Worker reaches Temporal at `TEMPORAL_ADDRESS` and the agent at the container's `TEMPORAL_ADDRESS=temporal:7233` (set in the compose file). The two communicate via the Temporal server, not directly.

### 1d. Run the dashboard

```bash
cd ../dashboard
npm install
echo 'NEXT_PUBLIC_PUKUCLOUD_API=http://localhost:8787' > .env.local
NEXT_PUBLIC_PUKUCLOUD_AUTH=token \
  NEXT_PUBLIC_PUKUCLOUD_ENV=local \
  npm run dev
# Open http://localhost:3000
```

Open the dashboard:

```bash
xdg-open http://localhost:3000      # Linux
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

You can also open the Temporal UI (`http://localhost:8080` — start with `docker compose --profile ui up -d`) to watch the workflow progress.

---

## Step 3 — Running multiple agents

A single host can run multiple PukuCloud agents. To add another:

```bash
# Stop the compose-managed agent and run two by hand instead.
docker compose -f docker-compose.dev.yml stop agent

# Build the agent locally.
cd ../agent
go build -o ../bin/pukucloud-agent ./cmd/agent

# Start agent A on port 9091, with worker_id=host-a.
docker run --rm --privileged \
  --device /dev/kvm --device /dev/net/tun \
  --cap-add NET_ADMIN --cap-add SYS_ADMIN \
  -v "$(pwd)/../data":/var/lib/pukucloud \
  -p 9091:9091 -p 9191:9100 \
  -e PUKUCLOUD_AGENT_LISTEN=0.0.0.0:9091 \
  -e PUKUCLOUD_METRICS_LISTEN=0.0.0.0:9191 \
  -e TEMPORAL_ADDRESS=temporal:7233 \
  -e PUKUCLOUD_WORKER_ID=host-a \
  -e PUKUCLOUD_REGION=local \
  -e PUKUCLOUD_CONTROLLER_URL=http://host.docker.internal:8787 \
  -e PUKUCLOUD_AGENT_TOKEN=pds_local_dev_token \
  -e PUKUCLOUD_ENV=development \
  pukucloud/api:latest
# Note: use a pre-built image or a custom Dockerfile that points at your ./bin/pukucloud-agent
```

In `wrangler dev`, both agents appear in `GET /v1/workers` within ~30 s, and activities round-robin between them.

---

## Step 4 — Tear down

```bash
# Stop the docker-compose stack
docker compose -f docker-compose.dev.yml down -v

# Stop the controller and dashboard dev servers
# (Ctrl-C in their terminals)
```

---

## Known limitations

- **Single-host local dev.** This brings up one agent (or two manually). Multi-host mutual failover needs a real cloud deploy.
- **Speed.** First sandbox create cold-bakes a template snapshot. ~20 s cold; ~150 ms warm.
- **Storage.** The agent's `/var/lib/pukucloud` holds the chunk cache, template preseeds, and (for managed Postgres) PGDATA. It grows but does not shrink. Wipe it with `sudo rm -rf /var/lib/pukucloud/*` if you want a cold cache.
- **No TLS.** Local dev serves the Worker over plain HTTP. Don't expose it to the network without putting a reverse proxy in front.
- **Stub auth.** Default mode is `AUTH_MODE=stub`, which accepts any `X-Stub-User` header. Switch to JWT (Supabase JWKS) before exposing the API — see [secrets-and-config.md](secrets-and-config.md).
- **Workers.dev does not satisfy DOs.** `wrangler dev`'s local mode emulates Durable Objects in-process. Behavior matches production for most tests; CF-specific edge cases (D1 read-replica lag, DO cross-isolate consistency) need a deployed environment.

---

## See also

- [setup-local-mac.md](setup-local-mac.md) — Apple Silicon alternative.
- [setup-control-plane-cloudflare.md](setup-control-plane-cloudflare.md) — production deploy.
- [architecture.md](architecture.md) — what's actually running.
- [repo-layout.md](repo-layout.md) — what each directory owns.
# Local development on Apple Silicon

Run PukuCloud end-to-end on a Mac with an Apple Silicon (M1/M2/M3/M4) chip. Lima boots a Linux microVM that exposes `/dev/kvm` via Apple Virtualization.framework's nested virtualization, then Firecracker runs inside it.

For Linux on a KVM host, see [setup-local-linux.md](setup-local-linux.md). For multi-node cloud deploys, see [setup-self-host-aws.md](setup-self-host-aws.md) or [setup-self-host-gcp.md](setup-self-host-gcp.md).

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

After the one-shot script finishes:

- A Lima microVM named `pukucloud` running Linux with `/dev/kvm` exposed.
- The Go API (`pukucloud-api`) and the Firecracker agent (`pukucloud-agent`) running inside the microVM.
- The Next.js dashboard running on the host at `http://localhost:3000`.
- A stub auth user (`dev`) and a dev API token (`pds_local_dev_token`).

Sandbox create/exec/delete works end-to-end against the in-microVM agent. The first create cold-bakes a template snapshot from the OCI image — expect ~30 s on a cold cache.

---

## Prerequisites

- macOS 13 or newer on Apple Silicon.
- Homebrew.
- ~10 GB of free disk (Lima VM + template cache).
- Outbound HTTPS access (for the OCI image pulls and for `apt` inside the VM).

The script installs Lima if missing:

```bash
brew install lima
```

---

## Step 1 — One-shot bring-up

```bash
git clone https://github.com/pukucloud/pukucloud
cd pukucloud-ai
bash scripts/mac-local-e2e.sh
```

The script will:

1. Create the `pukucloud` Lima VM with nested virtualization enabled (`lima/microvm.yaml`).
2. Boot it and wait for `/dev/kvm` to be available inside.
3. Install Go (if missing), then build the API and agent binaries.
4. Install them as systemd units inside the VM and start them.
5. Install dashboard dependencies and start the Next.js dev server on the host.
6. Run a final smoke test (create a sandbox from the `base` template and exec `echo hello`).

Open the dashboard:

```bash
open http://localhost:3000
```

---

## Step 2 — Smoke test

If the script's auto-smoke-test didn't run (or you want to run it again manually):

```bash
# Create a sandbox from the local API
curl -sS http://localhost:8080/v1/sandboxes \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"template":"base"}'

# Exec a command (substitute <id> from the response)
curl -sS http://localhost:8080/v1/sandboxes/<id>/exec \
  -H 'Authorization: Bearer pds_local_dev_token' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"echo","args":["hello"]}'

# Delete
curl -sS -X DELETE http://localhost:8080/v1/sandboxes/<id> \
  -H 'Authorization: Bearer pds_local_dev_token'
```

For token-based auth beyond the local dev token, mint a fresh one via the stub path:

```bash
curl -sS -X POST http://localhost:8080/v1/me/tokens \
  -H 'X-Stub-User: dev' -H 'Content-Type: application/json' \
  -d '{"label":"my-script"}'
```

---

## Step 3 — What to look at

| Thing | Where |
| --- | --- |
| Lima VM console | `limactl shell pukucloud` |
| API logs (inside VM) | `limactl shell pukucloud journalctl -u pukucloud-api -f` |
| Agent logs (inside VM) | `limactl shell pukucloud journalctl -u pukucloud-agent -f` |
| Dashboard | `http://localhost:3000` |
| API base URL | `http://localhost:8080` |
| Source tree | The repo root; the script mounted it into the VM. |

Iterate on Go code from the host:

```bash
# Rebuild + redeploy into the VM
make deploy-agent
```

`make help` lists every shortcut.

---

## Step 4 — Tear down

```bash
# Stop the VM but keep its data
limactl stop pukucloud

# Delete everything
make destroy         # alias for: limactl delete -f pukucloud
```

The dashboard dev server runs on the host; stop it with Ctrl-C in the terminal where you started it (or `pkill -f "next dev"`).

---

## Known limitations

- **Speed.** First sandbox create cold-bakes a template snapshot. Expect ~30 s on a cold cache; ~150 ms once warm.
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
- [Makefile](../Makefile) — `make help` for the full target list.
# Build & deploy a global template

Global (public, seeded) templates like `base`, `code-interpreter`, and `agent` are **not** built via `pukucloud template build`. They are baked directly on a Firecracker host from shell scripts, uploaded to R2, and synced to every agent on startup.

## Architecture

```mermaid
flowchart LR
    A["scripts/build-base-rootfs.sh<br/>(one-time base OS setup)"] --> B["ubuntu-24.04-net/rootfs.ext4<br/>(~2 GB)"]
    B --> C["scripts/bake-templates.sh<br/>(chroot-installs packages per template)"]
    C --> D["templates/&lt;name&gt;/rootfs.ext4"]
    D -->|upload[("R2 bucket<br/>pukucloud-snapshots")]
    E[("R2<br/>pukucloud-snapshots")] -->|range GET on agent boot| F["/var/lib/pukucloud/templates/"]
    F -->|InstanceStart --snapshot| G["Firecracker VM"]
```

The same `bake-templates.sh` script runs on any agent host (or in CI). After baking, push to the bucket the controller exposes as the `SNAPSHOTS` R2 bucket (`pukucloud-snapshots` by default). Agents pull from there automatically.

---

## Prerequisites

- SSH access to an agent host (a bare-metal host or the Lima VM in local dev).
- The bucket name must match `SNAPSHOTS` in `workers/wrangler.toml` (default `pukucloud-snapshots`).
- Run all bake commands **as root** on the agent host (the script bind-mounts `/dev`, `/proc`, `/sys`).

---

## Step 1 — SSH into an agent host

```bash
ssh user@agent-1
sudo -i
```

---

## Step 2 — (One-time) Build the base rootfs

Only needed if `ubuntu-24.04-net` does not exist or you need to rebuild it from scratch.

```bash
sudo bash /workspace/scripts/build-base-rootfs.sh
```

This will:

- Run `debootstrap` to create a minimal Ubuntu 24.04 rootfs.
- Install `pukucloud-init` and `pukucloud-autostart` systemd units.
- Output to `/var/lib/pukucloud/templates/ubuntu-24.04-net/rootfs.ext4`.

> The base rootfs rarely changes. Skip this step if `/var/lib/pukucloud/templates/ubuntu-24.04-net/rootfs.ext4` already exists.

---

## Step 3 — Bake the template

```bash
sudo bash /workspace/scripts/bake-templates.sh code-interpreter
```

To force a rebuild even if already present:

```bash
sudo FORCE=1 bash /workspace/scripts/bake-templates.sh code-interpreter
```

To bake all templates at once:

```bash
sudo bash /workspace/scripts/bake-templates.sh
```

What this does:

1. Clones `ubuntu-24.04-net/rootfs.ext4` as the starting point.
2. Resizes the image to the target `SIZE_MB` (12288 MB for `code-interpreter`).
3. Mounts the image + bind-mounts `/dev`, `/proc`, `/sys`.
4. Runs `tpl::code-interpreter()` inside a chroot (installs Python 3.13, Node.js 24, full DS/AI/Playwright stack).
5. Writes the final image to `/var/lib/pukucloud/templates/code-interpreter/rootfs.ext4`.
6. Writes `meta.json` with size, CPU, memory specs.
7. Purges any stale Firecracker snapshot so it gets rebuilt on next sandbox create.

---

## Step 4 — Upload to R2

```bash
# From your laptop, with wrangler authenticated:
wrangler r2 object put pukucloud-snapshots/templates/code-interpreter/rootfs.ext4 \
  --file=/var/lib/pukucloud/templates/code-interpreter/rootfs.ext4 \
  --remote

wrangler r2 object put pukucloud-snapshots/templates/code-interpreter/meta.json \
  --file=/var/lib/pukucloud/templates/code-interpreter/meta.json \
  --remote
```

Replace `pukucloud-snapshots` with whatever you named the `SNAPSHOTS` R2 binding in `wrangler.toml`.

---

## Step 5 — Sync to all agent hosts

Agents download from R2 on first use (the local chunk cache stays warm after that). To force a sync without rebooting, trigger the agent's seed-sync manually:

```bash
# On each agent host:
sudo systemctl restart pukucloud-agent
# Or trigger the in-agent refresh hook (if enabled in your build):
# sudo pukucloud-agent -snapshot-refresh
```

If you have not enabled the refresh hook, the simplest approach is to delete the agent's stale cached template and let it re-download on the next boot:

```bash
sudo systemctl stop pukucloud-agent
sudo rm -rf /var/lib/pukucloud/templates/code-interpreter
sudo systemctl start pukucloud-agent
```

---

## Step 6 — Verify

```bash
# Check template is present on agent:
cat /var/lib/pukucloud/templates/code-interpreter/meta.json
ls -lh /var/lib/pukucloud/templates/code-interpreter/

# Create a test sandbox using the template:
curl -X POST "$PUKUCLOUD_API/v1/sandboxes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template": "code-interpreter"}'
```

---

## Updating a template definition

The source of truth for what gets installed in each template is `scripts/bake-templates.sh`.

- Edit `tpl::<name>()` to change installed packages.
- Edit `SIZE_MB[<name>]` if the image needs more disk space.
- Edit `CPU_COUNT[<name>]` / `MEMORY_MB[<name>]` for different VM sizing.
- The Dockerfiles in `templates/<name>/Dockerfile` must stay in sync with `tpl::<name>()`.

After editing, repeat Steps 3–5.

---

## Storage backends

| Backend | Status | How to use |
|---|---|---|
| **Cloudflare R2** (default) | Production | `wrangler r2 object put … --remote`. The agent pulls via the controller's `SNAPSHOTS` R2 binding, or via a presigned Range GET if `R2_SNAPSHOT_TOKEN` is set. |
| **GCS** | Adapter present, not exercised by current dev paths. | Set `PUKUCLOUD_GCS_BUCKET` on the agent. |
| **S3** | Adapter present, not exercised by current dev paths. | Set `PUKUCLOUD_S3_BUCKET` on the agent. |

The agent's behavior for any backend is identical: on a cache miss it issues a ranged read into the local chunk cache at `/var/lib/pukucloud/templates/`.
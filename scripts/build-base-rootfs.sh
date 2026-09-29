#!/usr/bin/env bash
# scripts/build-base-rootfs.sh
#
# Build the `ubuntu-24.04-net` base rootfs + Firecracker kernel that all
# PukuCloud templates clone from.
#
# Run as root on the agent host (it needs debootstrap + chroot tools):
#   sudo bash scripts/build-base-rootfs.sh
#
# Result:
#   /var/lib/pukucloud/templates/ubuntu-24.04-net/rootfs.ext4   (~600MB → 2GiB sparse)
#   /var/lib/fcsandbox/kernels/vmlinux-5.10.239
#
# Optionally pushed to GCS / S3 so cloud-init can re-hydrate after a wipe:
#   PUKUCLOUD_GCS_BUCKET=pukucloud-dev-xxxxx  sudo -E bash scripts/build-base-rootfs.sh
#   PUKUCLOUD_S3_BUCKET=pukucloud-dev-xxxxx   sudo -E bash scripts/build-base-rootfs.sh
#
# Env knobs:
#   ROOTFS_SIZE_MB=2048    final image size
#   SUITE=noble            debootstrap suite (Ubuntu 24.04)
#   MIRROR=http://archive.ubuntu.com/ubuntu
#   KERNEL_URL=...         override kernel download
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

DATA_DIR="${DATA_DIR:-/var/lib/pukucloud}"
TEMPLATES="$DATA_DIR/templates"
KERNELS="${KERNELS:-$DATA_DIR/kernels}"
NAME="ubuntu-24.04-net"
OUT="$TEMPLATES/$NAME"
ROOTFS="$OUT/rootfs.ext4"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-2048}"
SUITE="${SUITE:-noble}"
MIRROR="${MIRROR:-http://archive.ubuntu.com/ubuntu}"
KERNEL_NAME="${KERNEL_NAME:-vmlinux-5.10.239}"
KERNEL_URL="${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.13/x86_64/$KERNEL_NAME}"
WORK="${WORK:-/var/lib/pukucloud-work/base}"

PUKUCLOUD_INIT_BIN="${PUKUCLOUD_INIT_BIN:-}"
if [[ -z "$PUKUCLOUD_INIT_BIN" ]]; then
  for cand in /usr/local/bin/pukucloud-init /opt/pukucloud/pukucloud-init "$(dirname "$0")/../bin/pukucloud-init"; do
    [[ -x "$cand" ]] && PUKUCLOUD_INIT_BIN="$cand" && break
  done
fi
[[ -n "$PUKUCLOUD_INIT_BIN" && -x "$PUKUCLOUD_INIT_BIN" ]] || {
  echo "pukucloud-init binary not found; set PUKUCLOUD_INIT_BIN or place it at /usr/local/bin/pukucloud-init" >&2; exit 1; }

# pukucloud-daemon: always-on in-guest exec/fs server over AF_VSOCK (port 5252).
# Phase-2 vsock transport. Optional — if absent the guest still boots and the
# host transparently uses SSH. We warn (not fail) so older build hosts that
# haven't cross-built the daemon yet can still produce a (SSH-only) rootfs.
PUKUCLOUD_DAEMON_BIN="${PUKUCLOUD_DAEMON_BIN:-}"
if [[ -z "$PUKUCLOUD_DAEMON_BIN" ]]; then
  for cand in /usr/local/bin/pukucloud-daemon "$(dirname "$0")/../bin/pukucloud-daemon"; do
    [[ -x "$cand" ]] && PUKUCLOUD_DAEMON_BIN="$cand" && break
  done
fi

log() { printf '\e[36m[%(%H:%M:%S)T]\e[0m %s\n' -1 "$*"; }

mkdir -p "$OUT" "$KERNELS" "$WORK"

# ── 1. Kernel ────────────────────────────────────────────────────────────────
if [[ ! -s "$KERNELS/$KERNEL_NAME" ]]; then
  log "fetching kernel: $KERNEL_URL"
  curl -fsSL -o "$KERNELS/$KERNEL_NAME" "$KERNEL_URL"
fi

# ── 2. Tooling ───────────────────────────────────────────────────────────────
log "ensuring debootstrap + tools"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  debootstrap e2fsprogs ca-certificates curl >/dev/null

# ── 3. Empty ext4 image ──────────────────────────────────────────────────────
MNT="$WORK/mnt"
mkdir -p "$MNT"
mountpoint -q "$MNT" && umount "$MNT" || true
rm -f "$ROOTFS"
log "creating $ROOTFS (${ROOTFS_SIZE_MB} MiB sparse)"
truncate -s "${ROOTFS_SIZE_MB}M" "$ROOTFS"
mkfs.ext4 -q -F "$ROOTFS"
mount -o loop "$ROOTFS" "$MNT"
trap 'umount -lf "$MNT" 2>/dev/null || true' EXIT

# ── 4. debootstrap ───────────────────────────────────────────────────────────
log "debootstrap $SUITE → rootfs (this is the long step, ~5-10min)"
debootstrap --variant=minbase \
  --include=systemd-sysv,init-system-helpers,udev,kmod,dbus,systemd-resolved,\
openssh-server,ca-certificates,curl,iproute2,iputils-ping,netbase,sudo,\
locales,less,nano,ssh-import-id \
  "$SUITE" "$MNT" "$MIRROR"

# ── 5. Configure rootfs ──────────────────────────────────────────────────────
log "configuring rootfs"

cp /etc/resolv.conf "$MNT/etc/resolv.conf"
echo "pukucloud" > "$MNT/etc/hostname"
cat > "$MNT/etc/hosts" <<EOF
127.0.0.1   localhost
127.0.1.1   pukucloud
EOF

# fstab — root, devpts, proc, sysfs, tmpfs (kernel autoconfig=ip= sets eth0)
cat > "$MNT/etc/fstab" <<'EOF'
/dev/vda    /              ext4   defaults,noatime  0 1
proc        /proc          proc   defaults          0 0
sysfs       /sys           sysfs  defaults          0 0
devpts      /dev/pts       devpts gid=5,mode=620    0 0
tmpfs       /run           tmpfs  defaults,nosuid   0 0
EOF

# Install pukucloud-init binary + service
install -m 0755 "$PUKUCLOUD_INIT_BIN" "$MNT/usr/local/bin/pukucloud-init"
cat > "$MNT/etc/systemd/system/pukucloud-init.service" <<'EOF'
[Unit]
Description=PukuCloud guest identity agent
DefaultDependencies=no
After=systemd-tmpfiles-setup.service
Before=network-online.target sshd.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/pukucloud-init --timeout=15s
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF

# Install pukucloud-daemon binary + service (Phase-2 vsock transport).
# Always-on AF_VSOCK server (port 5252) the host fast-path talks to instead of
# SSH. It must already be in accept() at snapshot time so restored guests answer
# immediately (the bake probes it via waitVsockReady before PauseAndSnapshot).
# Additive: pukucloud-init + sshd are untouched, so SSH stays a permanent
# fallback. Skipped (warn only) if the daemon binary wasn't cross-built.
if [[ -n "$PUKUCLOUD_DAEMON_BIN" && -x "$PUKUCLOUD_DAEMON_BIN" ]]; then
  log "installing pukucloud-daemon from $PUKUCLOUD_DAEMON_BIN"
  install -m 0755 "$PUKUCLOUD_DAEMON_BIN" "$MNT/usr/local/bin/pukucloud-daemon"
  cat > "$MNT/etc/systemd/system/pukucloud-daemon.service" <<'EOF'
[Unit]
Description=PukuCloud in-guest vsock exec/fs daemon
DefaultDependencies=no
After=systemd-tmpfiles-setup.service
Before=sshd.service
# Start as early as possible so the daemon is listening before the snapshot is
# taken; it does not depend on networking (AF_VSOCK is host-local).

[Service]
Type=simple
ExecStart=/usr/local/bin/pukucloud-daemon
Restart=always
RestartSec=1s
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF
else
  echo "WARNING: pukucloud-daemon binary not found; building SSH-only rootfs (no vsock fast-path). Set PUKUCLOUD_DAEMON_BIN to enable." >&2
fi

# Generic autostart hook: runs /etc/pukucloud/autostart.sh if a template provides
# one. No-op for templates that don't ship it. Used by templates that need a
# long-running server brought up on boot (so a preview URL works immediately).
# Background script — exec'd via /bin/bash. Logs to journal.
mkdir -p "$MNT/etc/pukucloud"
cat > "$MNT/usr/local/bin/pukucloud-autostart" <<'AUTO'
#!/bin/sh
# Wrapper invoked by pukucloud-autostart.service.
set -e
SCRIPT=/etc/pukucloud/autostart.sh
[ -x "$SCRIPT" ] || { echo "pukucloud-autostart: no $SCRIPT, nothing to do"; exit 0; }
exec /bin/bash -lc "$SCRIPT"
AUTO
chmod 0755 "$MNT/usr/local/bin/pukucloud-autostart"

cat > "$MNT/etc/systemd/system/pukucloud-autostart.service" <<'EOF'
[Unit]
Description=PukuCloud template autostart hook
After=pukucloud-init.service network-online.target sshd.service
Wants=network-online.target
ConditionPathExists=/etc/pukucloud/autostart.sh

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /workspace
ExecStart=/usr/local/bin/pukucloud-autostart
Restart=on-failure
RestartSec=3s
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF


sed -i 's/^#*PermitRootLogin.*/PermitRootLogin yes/' "$MNT/etc/ssh/sshd_config" || true
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$MNT/etc/ssh/sshd_config" || true

# Pre-generate ssh host keys so first boot is fast
chroot "$MNT" /usr/bin/ssh-keygen -A

# Enable / mask units inside the chroot
chroot "$MNT" /bin/bash -e <<'CHROOT'
set -e
systemctl enable pukucloud-init.service
systemctl enable ssh.service
systemctl enable pukucloud-autostart.service
# Phase-2 vsock daemon (only if its unit was installed above).
[ -f /etc/systemd/system/pukucloud-daemon.service ] && systemctl enable pukucloud-daemon.service || true
systemctl mask systemd-networkd.service
systemctl mask systemd-networkd-wait-online.service
systemctl mask systemd-resolved.service || true
# Provide a static resolv.conf since we masked resolved
rm -f /etc/resolv.conf
printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /etc/resolv.conf

# Root account: lock password (key-only via pukucloud-init)
passwd -l root || true

# Clear apt cache to shrink image
apt-get clean
rm -rf /var/lib/apt/lists/*
CHROOT

# Trim free space so .ext4 stays small when copied around
log "trimming rootfs"
fstrim "$MNT" 2>/dev/null || true

sync
umount "$MNT"
trap - EXIT

log "✓ base rootfs ready: $ROOTFS  ($(du -h "$ROOTFS" | cut -f1))"
log "✓ kernel:           $KERNELS/$KERNEL_NAME"

# ── 6. Optional: upload to bucket ────────────────────────────────────────────
if [[ -n "${PUKUCLOUD_GCS_BUCKET:-}" ]]; then
  log "uploading to gs://$PUKUCLOUD_GCS_BUCKET/"
  gcloud storage cp "$ROOTFS"             "gs://$PUKUCLOUD_GCS_BUCKET/templates/$NAME/rootfs.ext4"
  gcloud storage cp "$KERNELS/$KERNEL_NAME" "gs://$PUKUCLOUD_GCS_BUCKET/kernels/$KERNEL_NAME"
elif [[ -n "${PUKUCLOUD_S3_BUCKET:-}" ]]; then
  log "uploading to s3://$PUKUCLOUD_S3_BUCKET/"
  aws s3 cp "$ROOTFS"             "s3://$PUKUCLOUD_S3_BUCKET/templates/$NAME/rootfs.ext4"
  aws s3 cp "$KERNELS/$KERNEL_NAME" "s3://$PUKUCLOUD_S3_BUCKET/kernels/$KERNEL_NAME"
fi

log "done."

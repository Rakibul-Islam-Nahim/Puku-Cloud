#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/pukucloud-cloud-init.log) 2>&1

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl wget jq squashfs-tools iproute2 iptables uuid-runtime e2fsprogs sqlite3 caddy
# awscli is not in the Ubuntu 24.04 archive; install only if S3 bucket is configured
if [ -n "${PUKUCLOUD_S3_BUCKET:-}" ]; then
  apt-get install -y python3-pip && pip3 install --break-system-packages awscli || true
fi

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /usr/local/src/nodesource_setup_22.x
  bash /usr/local/src/nodesource_setup_22.x
  apt-get install -y nodejs
fi

install -d -m 0755 /usr/local/src/pukucloud-firecracker
if ! command -v firecracker >/dev/null 2>&1 || ! firecracker --version 2>/dev/null | grep -q '1.16.0'; then
  wget -qO /usr/local/src/pukucloud-firecracker/firecracker-v1.16.0-x86_64.tgz \
    https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.0/firecracker-v1.16.0-x86_64.tgz
  tar -xzf /usr/local/src/pukucloud-firecracker/firecracker-v1.16.0-x86_64.tgz -C /usr/local/src/pukucloud-firecracker
  install -m 0755 /usr/local/src/pukucloud-firecracker/release-v1.16.0-x86_64/firecracker-v1.16.0-x86_64 /usr/local/bin/firecracker
  install -m 0755 /usr/local/src/pukucloud-firecracker/release-v1.16.0-x86_64/jailer-v1.16.0-x86_64 /usr/local/bin/jailer
fi

groupadd -f kvm
usermod -aG kvm ubuntu
cat > /etc/udev/rules.d/99-kvm.rules <<'KVMRULES'
KERNEL=="kvm", GROUP="kvm", MODE="0660"
KVMRULES
udevadm control --reload-rules
udevadm trigger --name-match=kvm || true

sysctl -w net.ipv4.ip_forward=1
cat > /etc/sysctl.d/99-pukucloud.conf <<'SYSCTL'
net.ipv4.ip_forward=1
SYSCTL

install -d -m 0755 /var/lib/pukucloud /var/lib/fcsandbox/kernels /var/lib/fcsandbox/templates /var/lib/fcsandbox/vms /var/lib/fcsandbox/snapshots /run/fcsandbox /etc/pukucloud /etc/caddy /opt/pukucloud-dashboard

if [ ! -f /etc/pukucloud/env ]; then
  cat > /etc/pukucloud/env <<'ENV'
PUKUCLOUD_APP_FQDN=dev.pukucloud.dev
PUKUCLOUD_API_FQDN=api.dev.pukucloud.dev
PUKUCLOUD_S3_BUCKET=
PUKUCLOUD_GCS_BUCKET=
ENV
  chmod 0600 /etc/pukucloud/env
fi

set -a
# shellcheck disable=SC1091
. /etc/pukucloud/env
set +a

if [ -n "${PUKUCLOUD_GCS_BUCKET:-}" ]; then
  if command -v gcloud >/dev/null 2>&1; then
    gcloud storage rsync --recursive "gs://${PUKUCLOUD_GCS_BUCKET}/kernels/" /var/lib/fcsandbox/kernels/ || true
    gcloud storage rsync --recursive "gs://${PUKUCLOUD_GCS_BUCKET}/templates/" /var/lib/fcsandbox/templates/ || true
  elif command -v gsutil >/dev/null 2>&1; then
    gsutil -m rsync -r "gs://${PUKUCLOUD_GCS_BUCKET}/kernels/" /var/lib/fcsandbox/kernels/ || true
    gsutil -m rsync -r "gs://${PUKUCLOUD_GCS_BUCKET}/templates/" /var/lib/fcsandbox/templates/ || true
  else
    echo "PUKUCLOUD_GCS_BUCKET is set but neither gcloud nor gsutil is installed; skipping GCS kernel/template sync"
  fi
elif [ -n "${PUKUCLOUD_S3_BUCKET:-}" ]; then
  aws s3 sync "s3://${PUKUCLOUD_S3_BUCKET}/kernels/" /var/lib/fcsandbox/kernels/ || true
  aws s3 sync "s3://${PUKUCLOUD_S3_BUCKET}/templates/" /var/lib/fcsandbox/templates/ || true
else
  echo "Neither PUKUCLOUD_GCS_BUCKET nor PUKUCLOUD_S3_BUCKET is set yet; skipping kernel/template sync"
fi

cat > /etc/systemd/system/pukucloud-agent.service <<'UNIT'
[Unit]
Description=PukuCloud Firecracker agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/pukucloud/env
ExecStart=/usr/local/bin/pukucloud-agent -socket /run/fcsandbox/agent.sock -data-dir /var/lib/pukucloud -db /var/lib/pukucloud/pukucloud.db
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/pukucloud-api.service <<'UNIT'
[Unit]
Description=PukuCloud public API
After=network-online.target pukucloud-agent.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/pukucloud/env
ExecStart=/usr/local/bin/pukucloud-api -addr :8080 -agent-socket /run/fcsandbox/agent.sock -token-file /var/lib/pukucloud/tokens.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/pukucloud-dashboard.service <<'UNIT'
[Unit]
Description=PukuCloud dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/pukucloud/env
WorkingDirectory=/opt/pukucloud-dashboard
ExecStart=/bin/false
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/pukucloud-env.conf <<'UNIT'
[Service]
EnvironmentFile=/etc/pukucloud/env
UNIT

cat > /etc/caddy/Caddyfile <<'CADDY'
# Cloudflare should use SSL/TLS mode "Full" for dev: Caddy serves an internal
# self-signed certificate at the origin. For Full (strict), switch to DNS-01
# with the Cloudflare Caddy provider later.
{$PUKUCLOUD_APP_FQDN} {
  tls internal
  reverse_proxy localhost:3000
}

{$PUKUCLOUD_API_FQDN} {
  tls internal
  reverse_proxy localhost:8080
}
CADDY

systemctl daemon-reload
systemctl enable pukucloud-agent pukucloud-api pukucloud-dashboard
systemctl enable --now caddy

echo "cloud-init done at $(date -u)"

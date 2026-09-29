#!/usr/bin/env bash
# deploy/deploy-host.sh
#
# Cloud-agnostic deploy step: builds agent + api + dashboard locally, copies them
# to $HOST, writes /etc/pukucloud/env, restarts services.
#
# Required env vars:
#   HOST                  ssh-reachable host (IP or FQDN)
#   SSH_USER              defaults to ubuntu
#   APP_FQDN              dashboard FQDN (eg app.example.com)
#   API_FQDN              api FQDN     (eg api.example.com)
#   DATABASE_URL          Postgres DSN (Supabase pooler).
#   SUPABASE_JWKS_URL     Supabase JWKS endpoint.
#   SUPABASE_ISSUER       Supabase auth issuer.
#   STORAGE_BUCKET        GCS / S3 bucket for kernels+templates+snapshots. Optional.
#   STORAGE_DRIVER        "gcs" | "s3" | "local" (default "local").
#
# Optional flags:
#   --skip-build          reuse existing artifacts in deploy/.build/
#   --skip-dashboard      don't deploy the dashboard
set -euo pipefail

SKIP_BUILD=0
SKIP_DASHBOARD=0
SSH_USER="${SSH_USER:-ubuntu}"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)      SKIP_BUILD=1; shift ;;
    --skip-dashboard)  SKIP_DASHBOARD=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

: "${HOST:?HOST is required}"
: "${APP_FQDN:?APP_FQDN is required}"
: "${API_FQDN:?API_FQDN is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${SUPABASE_JWKS_URL:?SUPABASE_JWKS_URL is required}"
: "${SUPABASE_ISSUER:?SUPABASE_ISSUER is required}"
STORAGE_DRIVER="${STORAGE_DRIVER:-local}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
REMOTE="$SSH_USER@$HOST"
REMOTE_STAGE="/home/$SSH_USER/pukucloud-deploy"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
step()  { printf "\n${GREEN}==>${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}WARN:${NC} %s\n" "$*" >&2; }
fail()  { printf "${RED}FAIL${NC} %s\n" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
need ssh; need rsync; need scp; need curl

mkdir -p "$BUILD_DIR"

# ──────────────────────────────────────────────────────────────────────────────
# Build artifacts
# ──────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  need go
  step "Cross-compiling Go binaries for linux/amd64"
  (cd "$REPO_ROOT/agent" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUILD_DIR/pukucloud-agent" ./cmd/agent)
  (cd "$REPO_ROOT/api"   && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUILD_DIR/pukucloud-api"   ./cmd/api)
  (cd "$REPO_ROOT/agent" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUILD_DIR/pukucloud-init"  ./cmd/pukucloud-init)

  if [ "$SKIP_DASHBOARD" -eq 0 ]; then
    need npm
    step "Building dashboard"
    (cd "$REPO_ROOT/dashboard" && npm ci --no-audit --no-fund && npm run build)
  fi

fi

# ──────────────────────────────────────────────────────────────────────────────
# Stage env file
# ──────────────────────────────────────────────────────────────────────────────
step "Assembling /etc/pukucloud/env"
cat > "$BUILD_DIR/pukucloud.env" <<ENV
PUKUCLOUD_DB_DRIVER=postgres
PUKUCLOUD_DB_DSN=${DATABASE_URL}
SUPABASE_JWKS_URL=${SUPABASE_JWKS_URL}
SUPABASE_ISSUER=${SUPABASE_ISSUER}
SUPABASE_AUDIENCE=${SUPABASE_AUDIENCE:-authenticated}
PUKUCLOUD_NATID=${PUKUCLOUD_NATID:-1}
PUKUCLOUD_NATID_POOL_SIZE=${PUKUCLOUD_NATID_POOL_SIZE:-6}
PUKUCLOUD_DEFAULT_TTL_SECONDS=${PUKUCLOUD_DEFAULT_TTL_SECONDS:-300}
PUKUCLOUD_METRICS_LISTEN=${PUKUCLOUD_METRICS_LISTEN:-:9100}
PUKUCLOUD_APP_FQDN=${APP_FQDN}
PUKUCLOUD_API_FQDN=${API_FQDN}
PUKUCLOUD_AUTH_SKIP_PREFIXES=/healthz,/version,/metrics,/v1/metrics
ENV
case "$STORAGE_DRIVER" in
  gcs)
    echo "PUKUCLOUD_GCS_BUCKET=${STORAGE_BUCKET}" >> "$BUILD_DIR/pukucloud.env"
    # Snapshot/WAL bucket: user snapshot+fork replication, managed-DB WAL
    # archive and db restore. Unset = all three silently disabled, so default
    # to the seeds bucket (its lifecycle rules only match the snapshots/ prefix).
    echo "PUKUCLOUD_SNAPSHOT_BUCKET=${PUKUCLOUD_SNAPSHOT_BUCKET:-${STORAGE_BUCKET}}" >> "$BUILD_DIR/pukucloud.env"
    ;;
  s3)  echo "PUKUCLOUD_S3_BUCKET=${STORAGE_BUCKET}"  >> "$BUILD_DIR/pukucloud.env" ;;
esac
chmod 0600 "$BUILD_DIR/pukucloud.env"

# ──────────────────────────────────────────────────────────────────────────────
# Ship to host
# ──────────────────────────────────────────────────────────────────────────────
step "Staging on $REMOTE"
ssh -o StrictHostKeyChecking=accept-new "$REMOTE" "mkdir -p '$REMOTE_STAGE'"
scp "$BUILD_DIR/pukucloud.env" "$REMOTE:$REMOTE_STAGE/pukucloud.env"
ssh "$REMOTE" "sudo install -m 0600 -o root -g root '$REMOTE_STAGE/pukucloud.env' /etc/pukucloud/env && \
              sudo install -m 0600 -o root -g root '$REMOTE_STAGE/pukucloud.env' /etc/pukucloud/env.agent && \
              sudo sed -i 's|^SUPABASE_JWKS_URL=|#SUPABASE_JWKS_URL=|' /etc/pukucloud/env.agent"

# ── XFS+reflink data volume (enables ~1ms FICLONE rootfs CoW → sub-second boots)
step "Ensuring /var/lib/pukucloud is on XFS with reflink=1"
PUKUCLOUD_DATA_SIZE_GB="${PUKUCLOUD_DATA_SIZE_GB:-50}"
ssh "$REMOTE" "sudo bash -s" <<REMOTE_XFS
set -euo pipefail
need_migrate=1
if mountpoint -q /var/lib/pukucloud && [ "\$(stat -f -c %T /var/lib/pukucloud)" = "xfs" ] && xfs_info /var/lib/pukucloud 2>/dev/null | grep -q "reflink=1"; then
  echo "already on xfs+reflink — skipping"
  need_migrate=0
fi
if [ "\$need_migrate" = "1" ]; then
  apt-get install -y -qq xfsprogs >/dev/null
  systemctl stop pukucloud-api pukucloud-agent 2>/dev/null || true
  if [ ! -f /opt/pukucloud.img ]; then
    echo "creating /opt/pukucloud.img (${PUKUCLOUD_DATA_SIZE_GB}G XFS reflink loopback)"
    truncate -s ${PUKUCLOUD_DATA_SIZE_GB}G /opt/pukucloud.img
    mkfs.xfs -m reflink=1 -q /opt/pukucloud.img
  fi
  if [ -d /var/lib/pukucloud ] && [ ! -d /var/lib/pukucloud.preXFS ]; then
    echo "migrating existing /var/lib/pukucloud → XFS volume"
    mkdir -p /mnt/pukucloud-stage
    mount -o loop /opt/pukucloud.img /mnt/pukucloud-stage
    cp -a /var/lib/pukucloud/. /mnt/pukucloud-stage/ 2>/dev/null || true
    umount /mnt/pukucloud-stage
    mv /var/lib/pukucloud /var/lib/pukucloud.preXFS
  fi
  mkdir -p /var/lib/pukucloud
  mount -o loop /opt/pukucloud.img /var/lib/pukucloud
  if ! grep -q "/opt/pukucloud.img" /etc/fstab; then
    echo "/opt/pukucloud.img /var/lib/pukucloud xfs loop,defaults 0 0" >> /etc/fstab
  fi
fi
echo "verify:"
stat -f -c "fstype=%T" /var/lib/pukucloud
xfs_info /var/lib/pukucloud 2>/dev/null | grep -oE "reflink=[01]" | head -1 || true
REMOTE_XFS

step "Installing binaries"
rsync -avz "$BUILD_DIR/pukucloud-agent" "$BUILD_DIR/pukucloud-api" "$BUILD_DIR/pukucloud-init" "$REMOTE:$REMOTE_STAGE/"
ssh "$REMOTE" "sudo install -m 0755 '$REMOTE_STAGE/pukucloud-agent' /usr/local/bin/pukucloud-agent && \
              sudo install -m 0755 '$REMOTE_STAGE/pukucloud-api'   /usr/local/bin/pukucloud-api && \
              sudo install -m 0755 '$REMOTE_STAGE/pukucloud-init'  /usr/local/bin/pukucloud-init"

if [ "$SKIP_DASHBOARD" -eq 0 ]; then
  step "Deploying dashboard"
  ssh "$REMOTE" "sudo mkdir -p /opt/pukucloud-dashboard && sudo chown $SSH_USER:$SSH_USER /opt/pukucloud-dashboard"
  rsync -az --delete \
    "$REPO_ROOT/dashboard/.next" \
    "$REPO_ROOT/dashboard/public" \
    "$REPO_ROOT/dashboard/package.json" \
    "$REPO_ROOT/dashboard/package-lock.json" \
    "$REMOTE:/opt/pukucloud-dashboard/"
  ssh "$REMOTE" "cd /opt/pukucloud-dashboard && npm ci --omit=dev --silent --no-audit --no-fund"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Systemd units + caddy
# ──────────────────────────────────────────────────────────────────────────────
step "Writing systemd units + Caddyfile"
ssh "$REMOTE" "sudo tee /etc/systemd/system/pukucloud-agent.service >/dev/null" <<'UNIT'
[Unit]
Description=PukuCloud Firecracker agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=/etc/pukucloud/env.agent
ExecStart=/usr/local/bin/pukucloud-agent -socket /run/fcsandbox/agent.sock -data-dir /var/lib/pukucloud -db /var/lib/pukucloud/pukucloud.db
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

ssh "$REMOTE" "sudo tee /etc/systemd/system/pukucloud-api.service >/dev/null" <<'UNIT'
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

if [ "$SKIP_DASHBOARD" -eq 0 ]; then
  ssh "$REMOTE" "sudo tee /etc/systemd/system/pukucloud-dashboard.service >/dev/null" <<UNIT
[Unit]
Description=PukuCloud dashboard
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=/etc/pukucloud/env
WorkingDirectory=/opt/pukucloud-dashboard
ExecStart=/usr/bin/npm run start -- --hostname 127.0.0.1 --port 3000
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
fi

CADDY_BLOCKS=$(cat <<CADDY
{
  auto_https off
}

http://{\$PUKUCLOUD_APP_FQDN}, https://{\$PUKUCLOUD_APP_FQDN} {
  tls internal
  reverse_proxy localhost:3000
}
http://{\$PUKUCLOUD_API_FQDN}, https://{\$PUKUCLOUD_API_FQDN} {
  tls internal
  reverse_proxy localhost:8080
}
CADDY
)
ssh "$REMOTE" "sudo tee /etc/caddy/Caddyfile >/dev/null" <<<"$CADDY_BLOCKS"
ssh "$REMOTE" "sudo install -d -m 0755 /etc/systemd/system/caddy.service.d && sudo tee /etc/systemd/system/caddy.service.d/pukucloud-env.conf >/dev/null" <<'UNIT'
[Service]
EnvironmentFile=/etc/pukucloud/env
UNIT

step "Restarting services"
RESTART_LIST="caddy pukucloud-agent pukucloud-api"
[ "$SKIP_DASHBOARD" -eq 0 ] && RESTART_LIST="$RESTART_LIST pukucloud-dashboard"
ssh "$REMOTE" "sudo systemctl daemon-reload && sudo systemctl enable $RESTART_LIST && sudo systemctl restart $RESTART_LIST"

# ──────────────────────────────────────────────────────────────────────────────
# Health checks
# ──────────────────────────────────────────────────────────────────────────────
step "Health checks"
health() {
  local label="$1" url="$2"
  for _ in $(seq 1 15); do
    code=$(curl -ks -o /dev/null -w '%{http_code}' "$url" || true)
    if [[ "$code" =~ ^(2|3) ]]; then
      printf "  ${GREEN}OK${NC}  %-12s %s -> %s\n" "$label" "$url" "$code"
      return 0
    fi
    sleep 3
  done
  printf "  ${RED}FAIL${NC} %-12s %s\n" "$label" "$url" >&2
  return 1
}
health "api"        "https://$API_FQDN/healthz"        || warn "api health failed (DNS may not have propagated; verify locally on host)"
[ "$SKIP_DASHBOARD" -eq 0 ] && { health "dashboard" "https://$APP_FQDN/login" || warn "dashboard health failed (DNS may not have propagated)"; }

printf "\n${GREEN}Deploy complete${NC} (host=%s)\n" "$HOST"

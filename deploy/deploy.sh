#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: ./deploy/deploy.sh -h HOST [--skip-build] [--skip-dashboard]

Deploys PukuCloud agent, API, and dashboard to the dev Firecracker host.
HOST may be the instance Elastic IP or an FQDN.
USAGE
}

HOST=""
SKIP_BUILD=0
SKIP_DASHBOARD=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--host)
      HOST="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-dashboard)
      SKIP_DASHBOARD=1
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$HOST" ]; then
  echo "Missing required -h HOST" >&2
  usage >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/.build"
REMOTE="ubuntu@$HOST"
REMOTE_STAGE="/home/ubuntu/pukucloud-deploy"
ENV_FILE="$REPO_ROOT/.env.local"
# Your own FQDNs. No defaults: a default would point the deploy's DNS, TLS and
# health checks at someone else's hostnames.
: "${APP_FQDN:?set APP_FQDN to your dashboard FQDN, e.g. app.example.com}"
: "${API_FQDN:?set API_FQDN to your API FQDN, e.g. api.example.com}"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

step() {
  echo
  echo "STEP $1: $2"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Required command not found: $1" >&2; exit 1; }
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required environment variable: $name" >&2
    echo "Set it in $ENV_FILE or export it before running deploy." >&2
    exit 1
  fi
}

# Best-effort Terraform output lookup. Override the env dir with TF_ENV_DIR
# (defaults to the AWS multi-node env). Used only as a fallback when a value
# like PUKUCLOUD_S3_BUCKET isn't already set in the environment.
terraform_output() {
  local dir="${TF_ENV_DIR:-$REPO_ROOT/infra/terraform/envs/dev-aws}"
  terraform -chdir="$dir" output -raw "$1" 2>/dev/null || true
}

health_check() {
  local label="$1"
  local url="$2"
  local attempts=10
  local delay=3

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null; then
      printf "%bOK%b %s\n" "$GREEN" "$NC" "$label"
      return 0
    fi
    sleep "$delay"
  done

  printf "%bFAIL%b %s (%s)\n" "$RED" "$NC" "$label" "$url" >&2
  return 1
}

require_cmd ssh
require_cmd rsync
require_cmd scp
require_cmd curl
require_cmd terraform

mkdir -p "$BUILD_DIR"

if [ "$SKIP_BUILD" -eq 0 ]; then
  require_cmd go
  step 1 "Cross-compiling Go binaries for linux/amd64"
  pushd "$REPO_ROOT/agent" >/dev/null
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUILD_DIR/pukucloud-agent" ./cmd/agent
  popd >/dev/null

  pushd "$REPO_ROOT/api" >/dev/null
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$BUILD_DIR/pukucloud-api" ./cmd/api
  popd >/dev/null
else
  step 1 "Skipping Go build"
  [ -x "$BUILD_DIR/pukucloud-agent" ] && [ -x "$BUILD_DIR/pukucloud-api" ] || {
    echo "--skip-build requires existing $BUILD_DIR/pukucloud-agent and pukucloud-api" >&2
    exit 1
  }
fi

if [ "$SKIP_DASHBOARD" -eq 0 ]; then
  require_cmd npm
  step 2 "Building dashboard"
  pushd "$REPO_ROOT/dashboard" >/dev/null
  npm run build
  popd >/dev/null
else
  step 2 "Skipping dashboard build and deploy"
fi

step 3 "Assembling runtime environment"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

DATABASE_URL="${DATABASE_URL:-${DATABASE_DIRECT_URL:-}}"
require_env DATABASE_URL
require_env SUPABASE_JWKS_URL
require_env SUPABASE_ISSUER
PUKUCLOUD_S3_BUCKET="${PUKUCLOUD_S3_BUCKET:-$(terraform_output s3_bucket_name)}"
require_env PUKUCLOUD_S3_BUCKET

cat > "$BUILD_DIR/pukucloud.env" <<ENV
PUKUCLOUD_DB_DRIVER=postgres
PUKUCLOUD_DB_DSN=${DATABASE_URL}
SUPABASE_JWKS_URL=${SUPABASE_JWKS_URL}
SUPABASE_ISSUER=${SUPABASE_ISSUER}
SUPABASE_AUDIENCE=${SUPABASE_AUDIENCE:-authenticated}
PUKUCLOUD_NATID=${PUKUCLOUD_NATID:-1}
PUKUCLOUD_DEFAULT_TTL_SECONDS=${PUKUCLOUD_DEFAULT_TTL_SECONDS:-300}
PUKUCLOUD_METRICS_LISTEN=${PUKUCLOUD_METRICS_LISTEN:-:9100}
PUKUCLOUD_S3_BUCKET=${PUKUCLOUD_S3_BUCKET}
PUKUCLOUD_APP_FQDN=${PUKUCLOUD_APP_FQDN:-$APP_FQDN}
PUKUCLOUD_API_FQDN=${PUKUCLOUD_API_FQDN:-$API_FQDN}
ENV
chmod 0600 "$BUILD_DIR/pukucloud.env"

step 4 "Preparing remote host"
ssh "$REMOTE" "mkdir -p '$REMOTE_STAGE'"
scp "$BUILD_DIR/pukucloud.env" "$REMOTE:$REMOTE_STAGE/pukucloud.env"
ssh "$REMOTE" "sudo install -m 0600 -o root -g root '$REMOTE_STAGE/pukucloud.env' /etc/pukucloud/env && rm -f '$REMOTE_STAGE/pukucloud.env'"

step 5 "Installing binaries"
rsync -avz "$BUILD_DIR/pukucloud-agent" "$BUILD_DIR/pukucloud-api" "$REMOTE:$REMOTE_STAGE/"
ssh "$REMOTE" "sudo install -m 0755 '$REMOTE_STAGE/pukucloud-agent' /usr/local/bin/pukucloud-agent && sudo install -m 0755 '$REMOTE_STAGE/pukucloud-api' /usr/local/bin/pukucloud-api"

if [ "$SKIP_DASHBOARD" -eq 0 ]; then
  step 6 "Deploying dashboard"
  ssh "$REMOTE" "sudo mkdir -p /opt/pukucloud-dashboard && sudo chown ubuntu:ubuntu /opt/pukucloud-dashboard"
  rsync -avz --delete \
    "$REPO_ROOT/dashboard/.next" \
    "$REPO_ROOT/dashboard/public" \
    "$REPO_ROOT/dashboard/package.json" \
    "$REPO_ROOT/dashboard/package-lock.json" \
    "$REMOTE:/opt/pukucloud-dashboard/"
  ssh "$REMOTE" "cd /opt/pukucloud-dashboard && npm ci --omit=dev"
  ssh "$REMOTE" "sudo tee /etc/systemd/system/pukucloud-dashboard.service >/dev/null" <<'UNIT'
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

step 7 "Restarting services"
if [ "$SKIP_DASHBOARD" -eq 0 ]; then
  ssh "$REMOTE" "sudo systemctl daemon-reload && sudo systemctl enable pukucloud-dashboard && sudo systemctl restart caddy pukucloud-agent pukucloud-api pukucloud-dashboard"
else
  ssh "$REMOTE" "sudo systemctl daemon-reload && sudo systemctl restart caddy pukucloud-agent pukucloud-api"
fi

step 8 "Health checks"
health_check "api" "https://$API_FQDN/healthz"
if [ "$SKIP_DASHBOARD" -eq 0 ]; then
  health_check "dashboard" "https://$APP_FQDN/login"
else
  echo "Dashboard health check skipped."
fi

printf "%bDeploy complete%b\n" "$GREEN" "$NC"

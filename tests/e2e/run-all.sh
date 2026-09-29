#!/usr/bin/env bash
# tests/e2e/run-all.sh — orchestrate the end-to-end tests
# against a real PukuCloud deployment.
#
# This repo does not vendor the client SDKs (they are published separately), so
# the suite is the CLI lifecycle smoke test. Point PUKUCLOUD_API at a running
# control plane and export a token first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ "${PUKUCLOUD_E2E:-0}" != "1" ]]; then
  echo "[e2e] PUKUCLOUD_E2E is not set to 1 — skipping. (Set PUKUCLOUD_E2E=1 to run.)"
  exit 0
fi

: "${PUKUCLOUD_API:?must set PUKUCLOUD_API (e.g. http://localhost:8080)}"
: "${PUKUCLOUD_TOKEN:?must set PUKUCLOUD_TOKEN (run \`pukucloud auth login\` first)}"

echo "[e2e] target: $PUKUCLOUD_API"

# --- 0) Build CLI if missing -------------------------------------------------
if [[ ! -x bin/pukucloud ]]; then
  echo "[e2e] building CLI..."
  (cd cmd/pukucloud && go build -o "$ROOT/bin/pukucloud" .)
fi

# --- 1) CLI smoke ------------------------------------------------------------
echo "[e2e] cli smoke..."
bash tests/cli/smoke.sh

echo "[e2e] ✅ all passed"

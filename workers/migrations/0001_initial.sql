-- 0001_initial.sql — D1 schema for PukuCloud's Cloudflare Worker controller.
--
-- This migration creates the historical tables that the controller reads and
-- writes. Live state (worker heartbeats, VM status) lives in Durable Objects
-- for strongly consistent, low-latency reads. Anything durable — workflow
-- history, audit logs, per-org catalog — lives in D1.

CREATE TABLE IF NOT EXISTS workflows (
  -- workflow_id is what the controller passes to Temporal as the stable ID.
  -- Primary key here lets the controller look up the workflow's status
  -- from D1 without a Temporal round trip on hot dashboard paths.
  workflow_id TEXT PRIMARY KEY,
  workflow_type TEXT NOT NULL,                -- e.g. "LaunchMicroVMWorkflow"
  org_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,                       -- "queued" | "running" | "completed" | "failed" | "cancelled"
  input_json TEXT NOT NULL,                   -- original request body
  result_json TEXT,                           -- final result on completion
  error TEXT,                                 -- error message on failure
  worker_id TEXT,                             -- bare-metal agent that handled it (filled by Temporal signal)
  created_at INTEGER NOT NULL,                -- unix seconds
  completed_at INTEGER,                        -- unix seconds

  INDEX idx_workflows_org_created (org_id, created_at DESC),
  INDEX idx_workflows_status_created (status, created_at DESC),
  INDEX idx_workflows_type_created (workflow_type, created_at DESC)
);

CREATE TABLE IF NOT EXISTS worker_manifest (
  -- Lightweight manifest of every agent that has ever heartbeated.
  -- The live state lives in WorkerStateDO. This table is just an index
  -- so the controller can list known workers without enumerating all DO
  -- instances (which is not possible anyway).
  worker_id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  status TEXT NOT NULL,                       -- "active" | "offline" | "draining"
  last_seen INTEGER NOT NULL,                 -- unix seconds
  registered_at INTEGER NOT NULL,             -- unix seconds

  INDEX idx_manifest_last_seen (last_seen DESC),
  INDEX idx_manifest_region (region)
);

CREATE TABLE IF NOT EXISTS audit_log (
  -- One row per state-changing action (create VM, delete VM, etc.).
  -- Used by the dashboard's "activity feed" and for compliance audits.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  org_id TEXT NOT NULL,
  actor TEXT NOT NULL,                        -- user id / token id
  action TEXT NOT NULL,                       -- "vm.create" | "vm.delete" | ...
  workflow_id TEXT,
  details_json TEXT,                          -- JSON details (depends on action)

  INDEX idx_audit_org_ts (org_id, ts DESC),
  INDEX idx_audit_workflow (workflow_id)
);

-- Tokens for the controller's bearer auth. Mirrors the Go API's old
-- tokens.json / pg_tokens logic so the existing auth middleware keeps
-- working. See api/cmd/api/auth_pg.go for the historical version.
CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,                   -- bcrypt or sha256 of the bearer
  scope TEXT NOT NULL DEFAULT 'admin',        -- "admin" | "read"
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                         -- NULL = no expiry
  revoked_at INTEGER,

  INDEX idx_tokens_org (org_id)
);
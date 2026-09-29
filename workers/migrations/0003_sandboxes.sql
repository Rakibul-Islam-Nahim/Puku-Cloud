-- =============================================================================
-- 0003_sandboxes.sql
-- Mirror of the agent's sandbox catalogue as known to the control plane.
-- The agent is the source of truth for runtime state; this is a thin cache
-- for listings and audit.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sandboxes (
  id              TEXT PRIMARY KEY,                -- sandbox id (ulid)
  org_id          TEXT NOT NULL,
  template        TEXT NOT NULL,
  agent_id        TEXT,                            -- selected agent (multi-node)
  state           TEXT NOT NULL,                   -- 'creating'|'running'|'paused'|'hibernated'|'deleted'
  ip              TEXT,                            -- guest /30 slot
  ttl_seconds     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_org    ON sandboxes(org_id);
CREATE INDEX IF NOT EXISTS idx_sandboxes_agent  ON sandboxes(agent_id);
CREATE INDEX IF NOT EXISTS idx_sandboxes_state  ON sandboxes(state);

CREATE TABLE IF NOT EXISTS sandbox_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sandbox_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,                   -- 'create'|'exec'|'pause'|'resume'|'delete'|...
  payload         TEXT,                            -- json
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandbox_events ON sandbox_events(sandbox_id, created_at);

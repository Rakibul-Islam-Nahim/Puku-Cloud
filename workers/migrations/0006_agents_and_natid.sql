-- =============================================================================
-- 0006_agents_and_natid.sql
-- Multi-node agent registry + slot lease table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  base_url        TEXT NOT NULL,                   -- https://agent-N.internal.example.com:9090
  region          TEXT,
  capacity_cpu    INTEGER NOT NULL DEFAULT 0,
  capacity_mem_mb INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'healthy', -- 'healthy'|'degraded'|'offline'
  last_heartbeat  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id        TEXT PRIMARY KEY,
  sandbox_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  slot_index      INTEGER NOT NULL,                -- /30 slot in 172.20.0.0/16
  held_until      INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_leases_agent ON leases(agent_id);
CREATE INDEX IF NOT EXISTS idx_leases_sandbox ON leases(sandbox_id);

-- NAT-ID prewarm sentinel (mirror of api/internal/natid.go).
CREATE TABLE IF NOT EXISTS natid_prewarm (
  agent_id        TEXT NOT NULL,
  sentinel_ip     TEXT NOT NULL,
  warmed_at       INTEGER NOT NULL,
  PRIMARY KEY (agent_id, sentinel_ip)
);

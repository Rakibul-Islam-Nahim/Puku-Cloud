-- =============================================================================
-- 0004_databases.sql
-- Managed PostgreSQL catalogue (Beta). Source-of-truth lives in the agent's
-- Postgres today; on CF, this D1 table *is* the source of truth.
-- =============================================================================

CREATE TABLE IF NOT EXISTS databases (
  id              TEXT PRIMARY KEY,                -- ulid
  org_id          TEXT NOT NULL,
  label           TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  host_ip         TEXT,                            -- guest /30 slot
  state           TEXT NOT NULL,                   -- 'provisioning'|'ready'|'hibernated'|'failed'|'deleted'
  postgres_version TEXT NOT NULL DEFAULT '16',
  connection_url  TEXT,                            -- redacted; full URL never returned, see db_credentials
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_wake_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_databases_org ON databases(org_id);

CREATE TABLE IF NOT EXISTS database_credentials (
  database_id     TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                   -- bcrypt
  rotated_at      INTEGER NOT NULL,
  FOREIGN KEY (database_id) REFERENCES databases(id) ON DELETE CASCADE
);

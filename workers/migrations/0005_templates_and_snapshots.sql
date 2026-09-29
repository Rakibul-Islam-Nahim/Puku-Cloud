-- =============================================================================
-- 0005_templates_and_snapshots.sql
-- Template catalog (admin-curated + user-built) and named snapshots.
-- =============================================================================

CREATE TABLE IF NOT EXISTS templates (
  name            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                   -- 'builtin' | 'user'
  dockerfile_path TEXT,
  size_mb         INTEGER,
  vcpu            INTEGER,
  memory_mb       INTEGER,
  meta            TEXT,                            -- json
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS template_builds (
  id              TEXT PRIMARY KEY,
  template_name   TEXT NOT NULL,
  status          TEXT NOT NULL,                   -- 'queued'|'running'|'succeeded'|'failed'
  logs            TEXT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  FOREIGN KEY (template_name) REFERENCES templates(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  sandbox_id      TEXT,                            -- source sandbox (null for template snapshots)
  template        TEXT,
  r2_key          TEXT NOT NULL,                   -- bucket key (vm.mem / vmstate / rootfs.ext4)
  size_bytes      INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'available',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_org ON snapshots(org_id);

CREATE TABLE IF NOT EXISTS volumes (
  name            TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  size_mb         INTEGER NOT NULL,
  r2_key          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

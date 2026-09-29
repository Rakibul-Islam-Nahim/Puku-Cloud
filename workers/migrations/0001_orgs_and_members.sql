-- =============================================================================
-- 0001_orgs_and_members.sql
-- Mirrors api/internal/{orgs,auth_pg}.go schema.
-- =============================================================================

CREATE TABLE IF NOT EXISTS orgs (
  id              TEXT PRIMARY KEY,                 -- ulid
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,                 -- unix seconds
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orgs_slug ON orgs(slug);

CREATE TABLE IF NOT EXISTS org_members (
  org_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,                    -- subject from JWT, or stub user id
  role            TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS org_invites (
  token           TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  invited_by      TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  accepted_at     INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invites_org ON org_invites(org_id);

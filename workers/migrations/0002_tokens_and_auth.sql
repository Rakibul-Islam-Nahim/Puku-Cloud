-- =============================================================================
-- 0002_tokens_and_auth.sql
-- Mirrors api/internal/auth_pg.go.
-- File-token store (tokens.json) is replaced by this table.
-- =============================================================================

CREATE TABLE IF NOT EXISTS api_tokens (
  prefix          TEXT PRIMARY KEY,                -- first 12 chars, lookup index
  token_hash      TEXT NOT NULL,                   -- sha256 of full token
  user_id         TEXT NOT NULL,
  org_id          TEXT,
  label           TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_org  ON api_tokens(org_id);

-- Stub-mode identity (when SUPABASE_JWKS_URL is empty and auth=stub).
CREATE TABLE IF NOT EXISTS stub_users (
  user_id         TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  display_name    TEXT,
  created_at      INTEGER NOT NULL
);

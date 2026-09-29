/**
 * Bindings injected by wrangler into the Worker. See wrangler.toml.
 */
export interface Env {
  // Vars
  PUKUCLOUD_ENV: string;
  PUKUCLOUD_API_VERSION: string;
  PUKUCLOUD_AGENT_URLS: string;          // comma-separated
  PUKUCLOUD_DASHBOARD_URL: string;
  // Bindings
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  CACHE: KVNamespace;
  // Secrets
  PUKUCLOUD_AGENT_TOKEN?: string;        // bearer shared with agents
  PUKUCLOUD_ADMIN_TOKEN?: string;        // bootstrap admin token
  SUPABASE_JWKS_URL?: string;
  SUPABASE_ISSUER?: string;
  SUPABASE_AUDIENCE?: string;
  CLICKHOUSE_URL?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_PASSWORD?: string;
  R2_SNAPSHOT_TOKEN?: string;             // optional signed-token for R2 Range GETs
  AUTH_MODE?: "tokens" | "jwt" | "stub";  // default: 'tokens' if PUKUCLOUD_ADMIN_TOKEN set, else 'stub'
}

export type Variables = {
  user?: { id: string; email?: string; method: AuthMethod };
  org?: { id: string; slug: string };
  requestId: string;
};

export type AuthMethod = "token" | "jwt" | "stub" | "db-broker";

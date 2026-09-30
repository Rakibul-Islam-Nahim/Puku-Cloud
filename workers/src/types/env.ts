/**
 * Bindings injected by wrangler into the Worker. See wrangler.toml.
 */
export interface Env {
  // ---- Vars --------------------------------------------------------------
  PUKUCLOUD_ENV: string;
  PUKUCLOUD_API_VERSION: string;
  PUKUCLOUD_AGENT_URLS: string;          // legacy: kept for fallback routing
  PUKUCLOUD_DASHBOARD_URL: string;

  // Temporal (self-hosted). The controller talks to the HTTP API.
  TEMPORAL_ADDRESS?: string;             // e.g. "https://temporal.example.com:8233"
  TEMPORAL_NAMESPACE?: string;           // default: "default"
  TEMPORAL_AUTH_TOKEN?: string;          // optional bearer for HTTP API
  TEMPORAL_TASK_QUEUE?: string;          // default: "pukucloud-microvms"

  // Sentry (self-hosted). DSN format: https://<key>@host/<project>
  SENTRY_DSN?: string;

  // ---- Bindings -----------------------------------------------------------
  DB: D1Database;
  SNAPSHOTS: R2Bucket;
  CACHE: KVNamespace;

  /**
   * Durable Object namespace binding for per-worker live state.
   * Defined in wrangler.toml as [[durable_objects.bindings]].
   * Wrangler generates the helpers `idFromName` / `get` on it at runtime.
   */
  WORKER_STATE_DO?: DurableObjectNamespace;

  // ---- Secrets ------------------------------------------------------------
  PUKUCLOUD_AGENT_TOKEN?: string;        // bearer shared with agents (legacy path)
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
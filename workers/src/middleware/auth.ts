import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from "jose";
import type { MiddlewareHandler } from "hono";
import { sha256Hex, timingSafeEqual } from "../util/ulid.ts";
import { err } from "../util/json.ts";
import type { AuthMethod, Env, Variables } from "../types/env.ts";

/**
 * Three-mode auth:
 *   1. Bearer `pds_*` API token (D1 lookup by prefix, hash compare)
 *   2. Bearer JWT verified by Supabase JWKS (cached in module scope)
 *   3. PUKUCLOUD_AUTH_MODE=stub  →  `X-Stub-User` header
 *
 * Query-string `?access_token=…` is accepted for WS / EventSource clients
 * that can't set Authorization.
 *
 * Skip prefixes: /healthz, /readyz, /version, /metrics, /openapi.json,
 * /v1/internal/{natid,agents}   (agent endpoints authenticate via
 * PUKUCLOUD_AGENT_TOKEN inside the route),
 * /v1/databases/{id}/proxy[/...]   (the db-broker path forwards an in-VM
 * pds_pg_… token unchanged).
 */
export const SKIP_AUTH_PREFIXES = [
  "/healthz",
  "/readyz",
  "/version",
  "/metrics",
  "/openapi.json",
  "/v1/internal/natid",
  "/v1/internal/agents",
];

// Module-scope JWKS — jose caches keys internally.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJWKS(url: string) {
  let s = jwksCache.get(url);
  if (!s) {
    s = createRemoteJWKSet(new URL(url), { cooldownDuration: 60_000 });
    jwksCache.set(url, s);
  }
  return s;
}

export const unifiedAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const path = c.req.path;
  if (SKIP_AUTH_PREFIXES.some((p) => path === p || path.startsWith(p + "/") || path === p)) {
    // Allow through; health endpoints never auth.
    await next();
    return;
  }
  if (path.match(/^\/v1\/databases\/[^/]+\/proxy(\/|$)/)) {
    // DB-broker path: trust the in-VM token; the agent validates it.
    c.set("user", { id: "db-broker", method: "db-broker" });
    await next();
    return;
  }

  const bearer = extractBearer(c.req.raw);
  if (!bearer) {
    return err(401, "unauthorized", "Missing bearer token");
  }

  // 1. pds_* API token
  if (bearer.startsWith("pds_")) {
    const verified = await verifyApiToken(c.env, bearer);
    if (!verified) return err(401, "unauthorized", "Invalid API token");
    c.set("user", { id: verified.user_id, email: undefined, method: "token" });
    if (verified.org_id) c.set("org", { id: verified.org_id, slug: "" });
    await next();
    return;
  }

  // 2. JWT (Supabase) — a JWT is two base64url segments separated by '.', never starts with 'pds_'
  if (bearer.includes(".") && c.env.SUPABASE_JWKS_URL) {
    try {
      const payload = await verifyJwt(bearer, c.env);
      const userId = (payload.sub as string) ?? (payload.user_id as string);
      if (!userId) return err(401, "unauthorized", "JWT missing subject");
      c.set("user", { id: userId, email: payload.email as string, method: "jwt" });
      await next();
      return;
    } catch (e) {
      return err(401, "unauthorized", `JWT verification failed: ${(e as Error).message}`);
    }
  }

  // 3. Stub mode
  const authMode = c.env.AUTH_MODE ?? (c.env.PUKUCLOUD_ADMIN_TOKEN ? "tokens" : "stub");
  if (authMode === "stub") {
    const stub = c.req.header("x-stub-user");
    if (!stub) return err(401, "unauthorized", "Stub auth requires X-Stub-User header");
    c.set("user", { id: stub, email: `${stub}@stub.local`, method: "stub" });
    await next();
    return;
  }

  return err(401, "unauthorized", "Unsupported auth credential");
};

function extractBearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const url = new URL(req.url);
  const q = url.searchParams.get("access_token");
  return q ?? null;
}

async function verifyApiToken(env: Env, token: string): Promise<{ user_id: string; org_id: string | null } | null> {
  const prefix = token.slice(0, 12);
  const row = await env.DB.prepare(
    "SELECT token_hash, user_id, org_id, revoked_at FROM api_tokens WHERE prefix = ?1"
  ).bind(prefix).first<{ token_hash: string; user_id: string; org_id: string | null; revoked_at: number | null }>();
  if (!row) return null;
  if (row.revoked_at) return null;
  const hash = await sha256Hex(token);
  if (!timingSafeEqual(hash, row.token_hash)) return null;
  // Best-effort last_used_at update (non-blocking).
  env.DB.prepare("UPDATE api_tokens SET last_used_at = ?1 WHERE prefix = ?2")
    .bind(Math.floor(Date.now() / 1000), prefix).run().catch(() => {});
  return { user_id: row.user_id, org_id: row.org_id };
}

async function verifyJwt(token: string, env: Env): Promise<JWTPayload> {
  const jwks = getJWKS(env.SUPABASE_JWKS_URL!);
  const { payload }: JWTVerifyResult = await jwtVerify(token, jwks, {
    issuer: env.SUPABASE_ISSUER,
    audience: env.SUPABASE_AUDIENCE,
  });
  return payload;
}

/** Helper for downstream services to read auth method after unifiedAuth runs. */
export function authMethodOf(c: { get: (k: "user") => Variables["user"] }): AuthMethod {
  return c.get("user")?.method ?? "stub";
}

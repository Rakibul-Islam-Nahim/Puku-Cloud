import type { MiddlewareHandler } from "hono";

/** Permissive CORS for the API — the dashboard calls it cross-origin in dev.
 *  Tighten per-deployment via wrangler.toml [vars]. */
export const cors: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin") ?? "*";
  c.header("access-control-allow-origin", origin);
  c.header("vary", "Origin");
  c.header("access-control-allow-credentials", "true");
  c.header("access-control-allow-headers", "authorization, content-type, x-stub-user, x-request-id");
  c.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  c.header("access-control-max-age", "86400");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
};

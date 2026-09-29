import { Hono } from "hono";
import { json, err } from "../util/json.ts";
import { apiToken } from "../util/ulid.ts";
import type { Env, Variables } from "../types/env.ts";

export const tokenRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/me/tokens
tokenRoutes.get("/me/tokens", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const rows = await c.env.DB.prepare(
    `SELECT prefix, label, created_at, last_used_at, revoked_at
       FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC`
  ).bind(user.id).all();
  return json({ tokens: rows.results });
});

// POST /v1/me/tokens
tokenRoutes.post("/me/tokens", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const { label, org_id } = await c.req.json().catch(() => ({} as { label?: string; org_id?: string }));
  const { token, prefix, hash } = await apiToken();
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO api_tokens (prefix, token_hash, user_id, org_id, label, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(prefix, hash, user.id, org_id ?? null, label ?? null, now).run();
  // Returned ONCE — never again.
  return json({ token, prefix, label: label ?? null }, { status: 201 });
});

// DELETE /v1/me/tokens/:prefix
tokenRoutes.delete("/me/tokens/:prefix", async (c) => {
  const user = c.get("user");
  if (!user) return err(401, "unauthorized", "no user");
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ?1 WHERE prefix = ?2 AND user_id = ?3`
  ).bind(now, c.req.param("prefix"), user.id).run();
  return json({ ok: true });
});

import { Hono } from "hono";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json } from "../util/json.ts";
import type { Env, Variables } from "../types/env.ts";

export const snapshotRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/snapshots  — list from D1 catalogue.
snapshotRoutes.get("/snapshots", async (c) => {
  const org = c.get("org");
  const rows = await c.env.DB.prepare(
    `SELECT id, sandbox_id, template, size_bytes, state, created_at, expires_at
       FROM snapshots WHERE org_id = ?1 ORDER BY created_at DESC`
  ).bind(org?.id ?? "anon").all();
  return json({ snapshots: rows.results });
});

// GET / DELETE /v1/snapshots/:id  → proxy.
snapshotRoutes.all("/snapshots/*", (c) => proxyToAgent(c.req.raw, c.env, {
  routingKey: c.req.param("id"),
}));

import { Hono } from "hono";
import { z } from "zod";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json, err } from "../util/json.ts";
import { ulid } from "../util/ulid.ts";
import { getSink } from "../services/clickhouse.ts";
import type { Env, Variables } from "../types/env.ts";

export const sandboxRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CreateSandbox = z.object({
  template: z.string().min(1),
  ttl_seconds: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// POST /v1/sandboxes  — control-plane intercept before proxying.
sandboxRoutes.post("/sandboxes", async (c) => {
  const body = CreateSandbox.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);

  const user = c.get("user");
  const org = c.get("org");
  const id = ulid("sbx");
  const now = Math.floor(Date.now() / 1000);
  const ttl = body.data.ttl_seconds ?? 300;

  // 1. Persist in D1 (thin catalogue).
  await c.env.DB.prepare(
    `INSERT INTO sandboxes (id, org_id, template, state, ttl_seconds, created_at, updated_at, expires_at)
     VALUES (?1, ?2, ?3, 'creating', ?4, ?5, ?5, ?6)`
  ).bind(id, org?.id ?? user?.id ?? "anon", body.data.template, ttl, now, now + ttl).run();

  // 2. Forward to agent (proxy preserves the agent's response, including the
  //    real lifecycle state, which we'll patch back below).
  const proxyReq = new Request(c.req.raw, {
    method: "POST",
    body: JSON.stringify(body.data),
    headers: { "content-type": "application/json" },
  });
  const res = await proxyToAgent(proxyReq, c.env, { routingKey: id });
  const text = await res.text();
  let body2: Record<string, unknown> = {};
  try { body2 = JSON.parse(text); } catch { /* not JSON — pass through */ }
  if (body2.id) {
    await c.env.DB.prepare(
      `UPDATE sandboxes SET id = ?1, state = ?2, updated_at = ?3 WHERE id = ?4`
    ).bind(body2.id as string, (body2.state as string) ?? "creating", now, id).run();
  }

  // 3. Best-effort analytics.
  getSink().push(c.env, {
    ts: now,
    org_id: org?.id,
    sandbox_id: body2.id as string ?? id,
    kind: "sandbox.create",
    payload: { template: body.data.template, ttl_seconds: ttl },
  });

  return new Response(text, { status: res.status, headers: res.headers });
});

// GET /v1/sandboxes  — list from D1 catalogue.
sandboxRoutes.get("/sandboxes", async (c) => {
  const org = c.get("org");
  const rows = await c.env.DB.prepare(
    `SELECT id, template, state, agent_id, created_at, expires_at
       FROM sandboxes WHERE org_id = ?1
       ORDER BY created_at DESC LIMIT 200`
  ).bind(org?.id ?? "anon").all();
  return json({ sandboxes: rows.results });
});

// Everything else under /v1/sandboxes/*  →  proxy.
sandboxRoutes.all("/sandboxes/*", (c) => proxyToAgent(c.req.raw, c.env, {
  routingKey: c.req.param("*")?.split("/")[0],
}));

import { Hono } from "hono";
import { z } from "zod";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json, err } from "../util/json.ts";
import { ulid } from "../util/ulid.ts";
import { getSink } from "../services/clickhouse.ts";
import type { Env, Variables } from "../types/env.ts";

export const databaseRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CreateDatabase = z.object({
  label: z.string().min(1).max(64),
  size_mb: z.number().int().positive().optional(),
  always_on: z.boolean().optional(),
});

// POST /v1/databases
databaseRoutes.post("/databases", async (c) => {
  const body = CreateDatabase.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);

  const user = c.get("user");
  const org = c.get("org");
  const id = ulid("db");
  const now = Math.floor(Date.now() / 1000);

  // Choose an agent (round-robin by id for v1).
  const agents = (c.env.PUKUCLOUD_AGENT_URLS ?? "").split(",").filter(Boolean);
  const agentId = agents.length === 0 ? "local" : agents[id.charCodeAt(3) % agents.length]!;

  // 1. Forward to agent (which actually boots the DB VM).
  const proxyReq = new Request(c.req.raw, {
    method: "POST",
    body: JSON.stringify(body.data),
    headers: { "content-type": "application/json" },
  });
  const res = await proxyToAgent(proxyReq, c.env, { routingKey: id, forceAgent: agentId });
  const text = await res.text();

  if (res.ok) {
    await c.env.DB.prepare(
      `INSERT INTO databases (id, org_id, label, agent_id, state, postgres_version, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'provisioning', '16', ?5, ?5)`
    ).bind(id, org?.id ?? user?.id ?? "anon", body.data.label, agentId, now).run();

    getSink().push(c.env, {
      ts: now,
      org_id: org?.id,
      database_id: id,
      kind: "database.create",
      payload: { label: body.data.label, agent_id: agentId },
    });
  }

  return new Response(text, { status: res.status, headers: res.headers });
});

// GET /v1/databases
databaseRoutes.get("/databases", async (c) => {
  const org = c.get("org");
  const rows = await c.env.DB.prepare(
    `SELECT id, label, agent_id, state, postgres_version, created_at
       FROM databases WHERE org_id = ?1 ORDER BY created_at DESC`
  ).bind(org?.id ?? "anon").all();
  return json({ databases: rows.results });
});

// GET /v1/databases/:id
databaseRoutes.get("/databases/:id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, label, agent_id, state, postgres_version, created_at, last_wake_at
       FROM databases WHERE id = ?1`
  ).bind(c.req.param("id")).first();
  if (!row) return err(404, "not_found", "database not found");
  return json(row);
});

// DELETE /v1/databases/:id
databaseRoutes.delete("/databases/:id", async (c) => {
  const id = c.req.param("id");
  const res = await proxyToAgent(c.req.raw, c.env, { routingKey: id });
  if (res.ok) {
    await c.env.DB.prepare(`UPDATE databases SET state = 'deleted', updated_at = ?1 WHERE id = ?2`)
      .bind(Math.floor(Date.now() / 1000), id).run();
  }
  return res;
});

// POST /v1/databases/:id/wake  — used by db-proxy on cold connect.
databaseRoutes.post("/databases/:id/wake", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(`UPDATE databases SET last_wake_at = ?1 WHERE id = ?2`)
    .bind(Math.floor(Date.now() / 1000), id).run();
  return proxyToAgent(c.req.raw, c.env, { routingKey: id });
});

// Everything else (metrics/stats/logs/proxy/reset-credentials/failover) → agent.
databaseRoutes.all("/databases/*", (c) => {
  const path = c.req.path.replace(/^\/v1/, "");
  return proxyToAgent(c.req.raw, c.env, { routingKey: c.req.param("id") ?? path.split("/")[2] });
});

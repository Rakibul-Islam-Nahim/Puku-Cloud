import { Hono } from "hono";
import { z } from "zod";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json, err } from "../util/json.ts";
import { ulid } from "../util/ulid.ts";
import type { Env, Variables } from "../types/env.ts";

export const templateRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const RegisterTemplate = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  dockerfile_path: z.string(),
  size_mb: z.number().int().positive().optional(),
  vcpu: z.number().int().positive().optional(),
  memory_mb: z.number().int().positive().optional(),
});

// POST /v1/templates  — register a user-built template.
templateRoutes.post("/templates", async (c) => {
  const body = RegisterTemplate.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT OR REPLACE INTO templates
       (name, kind, dockerfile_path, size_mb, vcpu, memory_mb, meta, created_at, updated_at)
     VALUES (?1, 'user', ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
  ).bind(
    body.data.name,
    body.data.dockerfile_path,
    body.data.size_mb ?? null,
    body.data.vcpu ?? null,
    body.data.memory_mb ?? null,
    JSON.stringify({}),
    now,
  ).run();
  return json({ ok: true, name: body.data.name }, { status: 201 });
});

// GET /v1/templates
templateRoutes.get("/templates", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT name, kind, size_mb, vcpu, memory_mb, created_at FROM templates ORDER BY name`
  ).all();
  return json({ templates: rows.results });
});

// POST /v1/templates/build  — kick a build (agent does the heavy lifting).
const StartBuild = z.object({
  template: z.string(),
});
templateRoutes.post("/templates/build", async (c) => {
  const body = StartBuild.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);
  const id = ulid("bld");
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO template_builds (id, template_name, status, started_at) VALUES (?1, ?2, 'queued', ?3)`
  ).bind(id, body.data.template, now).run();
  // Fire-and-forget forward to an agent (it will return 202 quickly).
  c.executionCtx.waitUntil(
    proxyToAgent(c.req.raw, c.env, { routingKey: body.data.template })
      .catch((e) => console.warn("template build forward failed", e)),
  );
  return json({ id, status: "queued" }, { status: 202 });
});

templateRoutes.get("/templates/builds", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, template_name, status, started_at, finished_at
       FROM template_builds ORDER BY started_at DESC LIMIT 100`
  ).all();
  return json({ builds: rows.results });
});

templateRoutes.get("/templates/builds/:id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, template_name, status, started_at, finished_at, logs
       FROM template_builds WHERE id = ?1`
  ).bind(c.req.param("id")).first();
  if (!row) return err(404, "not_found", "build not found");
  return json(row);
});

// GET/DELETE /v1/templates/:name, /v1/snapshots/*  → proxy
templateRoutes.all("/templates/*", (c) => proxyToAgent(c.req.raw, c.env, {
  routingKey: c.req.param("name"),
}));

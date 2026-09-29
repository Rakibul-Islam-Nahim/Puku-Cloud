import { Hono } from "hono";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json } from "../util/json.ts";
import type { Env, Variables } from "../types/env.ts";

export const internalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/internal/agents  — list agents this Worker knows about.
internalRoutes.get("/internal/agents", (c) => {
  const agents = (c.env.PUKUCLOUD_AGENT_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return json({ agents });
});

// GET /v1/internal/natid/list  — proxied to the agent fleet (no auth required,
// used by the boot-time prewarmer).
internalRoutes.get("/internal/natid/list", (c) => proxyToAgent(c.req.raw, c.env));

// GET /v1/internal/r2/range?key=...&start=...&end=...  — proxy mode for R2.
// The agent fetches this Worker URL when no presign token is configured.
internalRoutes.get("/internal/r2/range", async (c) => {
  const url = new URL(c.req.url);
  const key = url.searchParams.get("key");
  const start = parseInt(url.searchParams.get("start") ?? "0", 10);
  const end = parseInt(url.searchParams.get("end") ?? "0", 10);
  if (!key) return json({ error: "missing key" }, { status: 400 });
  const obj = await c.env.SNAPSHOTS.get(key, { range: { offset: start, length: end - start + 1 } });
  if (!obj) return json({ error: "not found" }, { status: 404 });
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("content-range", `bytes ${start}-${end}/${(obj as R2ObjectBody).size}`);
  return new Response(obj.body, { headers });
});

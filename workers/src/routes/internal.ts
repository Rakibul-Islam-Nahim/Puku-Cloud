import { Hono } from "hono";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json, err } from "../util/json.ts";
import { listKnownWorkerIds, readWorkerState, writeWorkerState } from "../services/workerState.ts";
import type { Env, Variables } from "../types/env.ts";

export const internalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /v1/internal/agents  — list agents this Worker knows about.
internalRoutes.get("/internal/agents", (c) => {
  const agents = (c.env.PUKUCLOUD_AGENT_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return json({ agents });
});

// POST /v1/internal/agents/:worker_id/state — agent heartbeat.
//
// Auth: bearer PUKUCLOUD_AGENT_TOKEN (shared with the agent fleet; this is
// not user auth). The bearer is verified against the env var directly; no
// D1 round-trip.
//
// Effect: writes the live state to the per-worker Durable Object AND
// upserts a manifest row in D1 so the controller can list known workers
// without enumerating DO instances.
internalRoutes.post("/internal/agents/:worker_id/state", async (c) => {
  const expected = c.env.PUKUCLOUD_AGENT_TOKEN;
  if (!expected) {
    return err(401, "unauthorized", "agent auth not configured");
  }
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return err(401, "unauthorized", "bad agent token");
  }

  const workerId = c.req.param("worker_id");
  if (!workerId) {
    return err(400, "bad_request", "missing worker_id");
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return err(400, "bad_request", "invalid JSON body");
  }

  // Update DO (live state — strongly consistent per-worker reads).
  await writeWorkerState(c.env, workerId, body as Parameters<typeof writeWorkerState>[2]);

  // Update D1 manifest (so /v1/workers can list without scanning DOs).
  const region = typeof body.region === "string" ? body.region : "unknown";
  const status = typeof body.status === "string" ? body.status : "active";
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO worker_manifest (worker_id, region, status, last_seen, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(worker_id) DO UPDATE SET
       region = excluded.region,
       status = excluded.status,
       last_seen = excluded.last_seen`,
  )
    .bind(workerId, region, status, now)
    .run();

  return json({ ok: true });
});

// GET /v1/internal/agents/:worker_id/state — internal peek for ops tooling.
internalRoutes.get("/internal/agents/:worker_id/state", async (c) => {
  const expected = c.env.PUKUCLOUD_AGENT_TOKEN;
  if (!expected) {
    return err(401, "unauthorized", "agent auth not configured");
  }
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return err(401, "unauthorized", "bad agent token");
  }

  const workerId = c.req.param("worker_id");
  const state = await readWorkerState(c.env, workerId);
  if (!state) return err(404, "not_found", "worker has no live state");
  return json(state);
});

// GET /v1/workers — list all known agents with live state.
//
// Reads the D1 manifest for the worker ID list, then fetches each
// worker's DO in parallel for live state. Stale-DO reads are dropped to
// "offline" with a warning so the dashboard always renders something.
internalRoutes.get("/workers", async (c) => {
  const ids = await listKnownWorkerIds(c.env);
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        const state = await readWorkerState(c.env, id);
        return { id, state };
      } catch (e) {
        return { id, state: null, error: String(e) };
      }
    }),
  );
  return json({
    workers: results.map((r) => ({
      worker_id: r.id,
      ...r.state,
      online: r.state != null,
    })),
  });
});

// GET /v1/workers/:worker_id — full live state for one worker.
internalRoutes.get("/workers/:worker_id", async (c) => {
  const workerId = c.req.param("worker_id");
  const state = await readWorkerState(c.env, workerId);
  if (!state) return err(404, "not_found", "worker not registered");
  return json(state);
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
import { Hono } from "hono";
import { json } from "../util/json.ts";
import type { Env, Variables } from "../types/env.ts";

export const healthRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

healthRoutes.get("/healthz", (c) => json({ status: "ok" }));
healthRoutes.get("/readyz", async (c) => {
  // Probe D1 + R2.
  try {
    await c.env.DB.prepare("SELECT 1").first();
    await c.env.SNAPSHOTS.head("health/probe");
  } catch (e) {
    return json({ status: "degraded", error: (e as Error).message }, { status: 503 });
  }
  return json({ status: "ready" });
});
healthRoutes.get("/version", (c) => json({
  name: "pukucloud-api",
  version: c.env.PUKUCLOUD_API_VERSION,
  env: c.env.PUKUCLOUD_ENV,
  runtime: "cloudflare-workers",
}));

import { Hono } from "hono";
import { cors, requestId, unifiedAuth } from "./middleware/index.ts";
import { healthRoutes } from "./routes/health.ts";
import { sandboxRoutes } from "./routes/sandboxes.ts";
import { databaseRoutes } from "./routes/databases.ts";
import { templateRoutes } from "./routes/templates.ts";
import { snapshotRoutes } from "./routes/snapshots.ts";
import { orgRoutes } from "./routes/orgs.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import { internalRoutes } from "./routes/internal.ts";
import { proxyToAgent } from "./services/agentProxy.ts";
import { getSink } from "./services/clickhouse.ts";
import type { Env, Variables } from "./types/env.ts";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global chain: requestId → cors → unifiedAuth
app.use("*", requestId);
app.use("*", cors);
app.use("/v1/*", unifiedAuth);

// Health/version (no auth)
app.route("/", healthRoutes);

// Control-plane routes registered *before* the catch-all proxy.
app.route("/v1", sandboxRoutes);
app.route("/v1", databaseRoutes);
app.route("/v1", templateRoutes);
app.route("/v1", snapshotRoutes);
app.route("/v1", orgRoutes);
app.route("/v1", tokenRoutes);
app.route("/v1", internalRoutes);

// Catch-all proxy: every remaining /v1/* falls through to the agent.
// Also handles WS upgrades (Hono passes the Upgrade request through to fetch).
app.all("/v1/*", (c) => {
  // Extract a routing key when the path looks like /v1/{plural}/{id}/...
  const m = c.req.path.match(/^\/v1\/(sandboxes|databases)\/([^/]+)/);
  return proxyToAgent(c.req.raw, c.env, {
    routingKey: m ? m[2] : undefined,
  });
});

// Anything else: 404
app.all("*", (c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await app.fetch(req, env, ctx);
    // Best-effort periodic ClickHouse flush.
    ctx.waitUntil(getSink().maybeFlush(env));
    return res;
  },
};

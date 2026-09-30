import { Hono } from "hono";
import { z } from "zod";
import { proxyToAgent } from "../services/agentProxy.ts";
import { json, err } from "../util/json.ts";
import { ulid } from "../util/ulid.ts";
import { startWorkflow, describeWorkflow } from "../services/temporal.ts";
import { captureException } from "../services/sentry.ts";
import type { Env, Variables } from "../types/env.ts";

export const sandboxRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CreateSandbox = z.object({
  template: z.string().min(1),
  vcpu_count: z.number().int().positive().max(64).optional(),
  mem_mib: z.number().int().positive().max(65536).optional(),
  disk_gib: z.number().int().positive().max(1024).optional(),
  ttl_seconds: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /v1/sandboxes — start a Temporal workflow that orchestrates the
 * microVM launch on a bare-metal agent.
 *
 * Flow:
 *   1. Validate input.
 *   2. Generate a stable workflow ID (also used as the VM ID).
 *   3. Insert a "queued" row in D1 history.
 *   4. Start the workflow on Temporal. The server picks an available
 *      agent via its task queue; the controller doesn't know or care
 *      which agent runs it.
 *   5. Return 202 Accepted with the workflow ID; the client polls or
 *      listens for completion.
 */
sandboxRoutes.post("/sandboxes", async (c) => {
  const body = CreateSandbox.safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return err(400, "bad_request", body.error.message);

  const user = c.get("user");
  const org = c.get("org");
  const workflowId = ulid("vm");
  const now = Math.floor(Date.now() / 1000);
  const ttl = body.data.ttl_seconds ?? 300;

  // 1. Write the workflow row to D1 so the dashboard can list "recently
  //    launched" VMs without asking Temporal.
  await c.env.DB.prepare(
    `INSERT INTO workflows (workflow_id, workflow_type, org_id, requested_by, status, input_json, created_at)
     VALUES (?1, 'LaunchMicroVMWorkflow', ?2, ?3, 'queued', ?4, ?5)`,
  ).bind(
    workflowId,
    org?.id ?? user?.id ?? "anon",
    user?.id ?? "anon",
    JSON.stringify(body.data),
    now,
  ).run().catch(async (e) => {
    // Don't fail the request if D1 is briefly down — the workflow
    // start itself is the source of truth.
    await captureException(c.env, e, { tags: { stage: "d1_insert" } });
  });

  // 2. Start the workflow. This is the moment the controller
  //    officially hands off to Temporal.
  try {
    await startWorkflow(c.env, {
      workflowType: "LaunchMicroVMWorkflow",
      workflowId,
      taskQueue: c.env.TEMPORAL_TASK_QUEUE ?? "pukucloud-microvms",
      input: {
        spec: {
          template: body.data.template,
          vcpu_count: body.data.vcpu_count ?? 1,
          mem_mib: body.data.mem_mib ?? 256,
          disk_gib: body.data.disk_gib ?? 10,
          ttl_seconds: ttl,
          org_id: org?.id ?? user?.id ?? "anon",
          requested_by: user?.id ?? "anon",
          region: body.data.metadata?.region as string | undefined,
        },
        workflow_id: workflowId,
      },
    });
  } catch (e) {
    await captureException(c.env, e, { tags: { stage: "temporal_start", workflow_id: workflowId } });
    return err(502, "temporal_unavailable", "failed to start workflow");
  }

  // 3. Return 202 with the workflow ID. The client polls
  //    GET /v1/sandboxes/:workflowId for status, or subscribes via
  //    the dashboard's SSE.
  return json({ id: workflowId, status: "queued" }, { status: 202 });
});

/**
 * GET /v1/sandboxes/:id — get live status for a single VM.
 *
 * Reads from D1 (durable history) first; if the workflow is still in
 * "queued" or "running", additionally queries Temporal for the
 * authoritative state.
 */
sandboxRoutes.get("/sandboxes/:id", async (c) => {
  const id = c.req.param("id");
  const org = c.get("org");
  const row = await c.env.DB.prepare(
    `SELECT workflow_id, status, created_at, completed_at, error
       FROM workflows WHERE workflow_id = ?1 AND org_id = ?2`,
  ).bind(id, org?.id ?? "anon").first();

  if (!row) return err(404, "not_found", "no such sandbox");

  // If the workflow is still in flight, get live state from Temporal.
  let live = null;
  if (row.status === "queued" || row.status === "running") {
    try {
      live = await describeWorkflow(c.env, id);
    } catch (e) {
      await captureException(c.env, e, { tags: { stage: "temporal_describe", workflow_id: id } });
    }
  }

  return json({
    id: row.workflow_id,
    status: row.status,
    created_at: row.created_at,
    completed_at: row.completed_at,
    error: row.error,
    temporal: live,
  });
});

// GET /v1/sandboxes — list from D1 workflows history.
sandboxRoutes.get("/sandboxes", async (c) => {
  const org = c.get("org");
  const rows = await c.env.DB.prepare(
    `SELECT workflow_id AS id, workflow_type AS type, status, created_at, completed_at
       FROM workflows WHERE org_id = ?1 AND workflow_type = 'LaunchMicroVMWorkflow'
       ORDER BY created_at DESC LIMIT 200`,
  ).bind(org?.id ?? "anon").all();
  return json({ sandboxes: rows.results });
});

// DELETE /v1/sandboxes/:id — cancel a running workflow.
sandboxRoutes.delete("/sandboxes/:id", async (c) => {
  const id = c.req.param("id");
  // Trigger Temporal cancel; the workflow's activities will see the
  // cancellation context and stop. D1 row is updated asynchronously
  // by the agent (or we update here on best-effort).
  const { cancelWorkflow } = await import("../services/temporal.ts");
  try {
    await cancelWorkflow(c.env, id);
  } catch (e) {
    if (!(e instanceof Error && /not found/i.test(e.message))) {
      await captureException(c.env, e, { tags: { stage: "temporal_cancel", workflow_id: id } });
    }
  }
  return json({ id, status: "cancelling" });
});

// Everything else under /v1/sandboxes/* (e.g. /v1/sandboxes/{id}/exec) →
// legacy proxy to the agent that owns this VM. The agent's stable hash
// pick ensures the same VM always lands on the same agent.
sandboxRoutes.all("/sandboxes/*", (c) =>
  proxyToAgent(c.req.raw, c.env, {
    routingKey: c.req.param("*")?.split("/")[0],
  }),
);
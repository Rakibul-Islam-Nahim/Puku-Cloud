/**
 * Temporal client wrapper for the Cloudflare Worker controller.
 *
 * The controller does NOT talk to bare-metal agents directly. Instead it
 * talks to a (self-hosted) Temporal server. Workers (Go agents) poll
 * Temporal for activities, so the controller can start, signal, and query
 * workflows without knowing any agent IP.
 *
 * The Temporal frontend speaks gRPC. Cloudflare Workers cannot open raw
 * TCP sockets to arbitrary ports, so we go through Temporal's HTTP API
 * (port 8233 by default). The HTTP API supports the operations we need:
 * start, signal, query, cancel, terminate, and describe workflows.
 *
 * Adding a new workflow on the agent side? Just call startWorkflowClient
 * with the workflow type name — no controller changes needed for new
 * worker types.
 */

import type { Env } from "../types/env.ts";

export interface TemporalConfig {
  /** Address of the Temporal HTTP API (frontend). E.g. "https://temporal.example.com:8233" */
  baseUrl: string;
  /** Namespace. Usually "default". */
  namespace: string;
}

/**
 * Read Temporal config from the worker's env bindings.
 *
 * @param env Worker env (Cloudflare bindings + vars).
 */
export function temporalConfig(env: Env): TemporalConfig {
  const baseUrl = env.TEMPORAL_ADDRESS?.trim() || "http://localhost:8233";
  const namespace = env.TEMPORAL_NAMESPACE?.trim() || "default";
  return { baseUrl: baseUrl.replace(/\/+$/, ""), namespace };
}

/**
 * Start a workflow. Returns the workflow ID assigned by Temporal.
 *
 * The caller decides the workflow ID (workflowId); pass it through from
 * your request so retries are idempotent — starting the same workflow ID
 * twice returns the original one instead of creating a duplicate.
 *
 * @param env Worker env.
 * @param workflowType Workflow function name registered on the worker side.
 * @param workflowId Stable id (e.g. "vm-launch-<ulid>").
 * @param taskQueue Task queue the worker polls.
 * @param input JSON-serializable input to the workflow function.
 */
export async function startWorkflow(
  env: Env,
  args: {
    workflowType: string;
    workflowId: string;
    taskQueue: string;
    input: unknown;
  },
): Promise<string> {
  const cfg = temporalConfig(env);

  // Temporal HTTP API: POST /api/v1/namespaces/{namespace}/workflows
  // The "request_id" makes the start idempotent — Temporal returns the
  // existing workflow ID if you've started this one before within the
  // retention window.
  const url = `${cfg.baseUrl}/api/v1/namespaces/${encodeURIComponent(cfg.namespace)}/workflows`;

  const body = {
    request_id: args.workflowId,
    workflow_id: args.workflowId,
    workflow_type: { name: args.workflowType },
    task_queue: { name: args.taskQueue },
    input: serializePayload(args.input),
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Optional basic auth — set TEMPORAL_AUTH_TOKEN to enable.
  if (env.TEMPORAL_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${env.TEMPORAL_AUTH_TOKEN}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TemporalError(`startWorkflow ${args.workflowType} failed: ${res.status} ${text}`);
  }
  // 200 OK on idempotent re-start, 201 Created on first start. Body is the
  // workflow execution info; the workflow ID is in args.WorkflowId.
  return args.workflowId;
}

/**
 * Describe a workflow — returns its current status, history length, etc.
 *
 * Useful for the controller's GET /v1/sandboxes/:id endpoint to surface
 * "your VM is booting" / "ready" / "failed".
 */
export async function describeWorkflow(
  env: Env,
  workflowId: string,
): Promise<WorkflowExecutionInfo> {
  const cfg = temporalConfig(env);
  const url =
    `${cfg.baseUrl}/api/v1/namespaces/${encodeURIComponent(cfg.namespace)}` +
    `/workflows/${encodeURIComponent(workflowId)}`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.TEMPORAL_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${env.TEMPORAL_AUTH_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (res.status === 404) {
    throw new TemporalError(`workflow ${workflowId} not found`, 404);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TemporalError(`describeWorkflow failed: ${res.status} ${text}`);
  }
  const data = await res.json() as { workflowExecutionInfo: WorkflowExecutionInfo };
  return data.workflowExecutionInfo;
}

/**
 * Signal a running workflow. Used for "cancel this VM launch", "extend
 * TTL", etc. — anything that doesn't fit the workflow's own logic.
 */
export async function signalWorkflow(
  env: Env,
  args: { workflowId: string; signalName: string; input: unknown },
): Promise<void> {
  const cfg = temporalConfig(env);
  const url =
    `${cfg.baseUrl}/api/v1/namespaces/${encodeURIComponent(cfg.namespace)}` +
    `/workflows/${encodeURIComponent(args.workflowId)}` +
    `/signals/${encodeURIComponent(args.signalName)}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (env.TEMPORAL_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${env.TEMPORAL_AUTH_TOKEN}`;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(serializePayload(args.input)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TemporalError(`signalWorkflow failed: ${res.status} ${text}`);
  }
}

/**
 * Cancel a running workflow. Best-effort; the workflow's activities may
 * not actually be interrupted until they next check the cancellation
 * context.
 */
export async function cancelWorkflow(env: Env, workflowId: string): Promise<void> {
  const cfg = temporalConfig(env);
  const url =
    `${cfg.baseUrl}/api/v1/namespaces/${encodeURIComponent(cfg.namespace)}` +
    `/workflows/${encodeURIComponent(workflowId)}/cancel`;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (env.TEMPORAL_AUTH_TOKEN) {
    headers["Authorization"] = `Bearer ${env.TEMPORAL_AUTH_TOKEN}`;
  }

  const res = await fetch(url, { method: "POST", headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new TemporalError(`cancelWorkflow failed: ${res.status} ${text}`);
  }
}

/**
 * Subset of Temporal's workflow execution info — the fields the
 * controller actually uses. See:
 * https://docs.temporal.io/web-ui-server-api
 */
export interface WorkflowExecutionInfo {
  workflowId: string;
  runId: string;
  type: { name: string };
  status: "Running" | "Completed" | "Failed" | "Canceled" | "Terminated" | "ContinuedAsNew" | "TimedOut";
  startTime: string;
  closeTime?: string;
  historyLength?: number;
}

/** Convert a JS value to a Temporal JSON payload. */
function serializePayload(input: unknown) {
  // Workflow inputs are JSON payloads — Temporal accepts UTF-8 JSON.
  return {
    payloads: [
      {
        metadata: { encoding: "json/plain" },
        data: btoa(JSON.stringify(input)),
      },
    ],
  };
}

export class TemporalError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
    this.name = "TemporalError";
  }
}
/**
 * WorkerStateDO accessor for HTTP routes.
 *
 * Routes call getWorkerStateDO(env, workerId) to get a handle, then
 * .fetch(...) to read or write. The binding name is set in wrangler.toml.
 */

import type { Env } from "../types/env.ts";
import type { WorkerState } from "../durable_objects/workerState.ts";

/**
 * Resolve the DO instance for a given worker ID.
 *
 * Each unique worker ID maps to its own DO instance (Durable Object
 * namespace keys). The first .fetch() call creates the instance;
 * subsequent calls reuse it.
 */
export function getWorkerStateDO(env: Env, workerId: string) {
  if (!env.WORKER_STATE_DO) {
    throw new Error("WORKER_STATE_DO binding not configured in wrangler.toml");
  }
  // fromWorkerId is provided by the @cloudflare/workers-types generated
  // helpers. Cast through unknown because the binding type is generic.
  const ns = env.WORKER_STATE_DO as unknown as {
    idFromName(name: string): { toString(): string };
    get(id: { toString(): string }): { fetch(req: Request): Promise<Response> };
  };
  const id = ns.idFromName(workerId);
  return ns.get(id);
}

/** Read a worker's current state. Returns null if not registered. */
export async function readWorkerState(
  env: Env,
  workerId: string,
): Promise<WorkerState | null> {
  const doStub = getWorkerStateDO(env, workerId);
  const res = await doStub.fetch(
    new Request("https://do/state", { method: "GET" }),
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`readWorkerState: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as WorkerState;
}

/** Write a worker's state from inside a Temporal activity. */
export async function writeWorkerState(
  env: Env,
  workerId: string,
  state: Partial<WorkerState>,
): Promise<void> {
  const doStub = getWorkerStateDO(env, workerId);
  const res = await doStub.fetch(
    new Request("https://do/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId, ...state }),
    }),
  );
  if (!res.ok) {
    throw new Error(`writeWorkerState: ${res.status} ${await res.text()}`);
  }
}

/**
 * List all known workers. Reads a manifest index from D1 (kept in sync
 * by agent heartbeats). Returns IDs only; callers fetch live state from
 * the DOs individually.
 */
export async function listKnownWorkerIds(env: Env): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT worker_id FROM worker_manifest ORDER BY last_seen DESC LIMIT 1000`,
  ).all<{ worker_id: string }>();
  return (res.results ?? []).map((r) => r.worker_id);
}
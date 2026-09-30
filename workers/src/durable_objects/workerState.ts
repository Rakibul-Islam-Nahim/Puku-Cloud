/**
 * Durable Object: per-agent live state.
 *
 * Each bare-metal agent (worker host) has one DO instance keyed by its
 * worker ID. The agent updates its state via internal HTTP (from inside
 * a Temporal activity). The controller reads the state via the public
 * API to show real-time status in the dashboard.
 *
 * Why a Durable Object and not D1 or KV?
 *   - D1: strong consistency but no built-in per-key concurrency.
 *   - KV: eventual consistency; reads can lag behind writes.
 *   - DO: single-writer, strongly consistent, low latency from any CF
 *     region. Perfect for "this worker is currently doing X".
 *
 * Lifecycle:
 *   - Agent registers → DO.init called once, then state updated via
 *     writeState() on heartbeats.
 *   - Controller reads via fetch() (the public DO HTTP API).
 *   - Last-seen is used to detect dead agents (controller side).
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types/env.ts";

export interface WorkerState {
  workerId: string;
  region: string;
  status: "idle" | "busy" | "launching" | "draining" | "offline";
  currentVmId?: string;
  capacity: {
    cpuTotal: number;
    cpuUsed: number;
    memTotalMb: number;
    memUsedMb: number;
  };
  lastSeen: string; // ISO timestamp
  workflowCount: number;
  version?: string;
}

export class WorkerStateDO extends DurableObject<Env> {
  /** In-memory state, persisted on every write. */
  private state: WorkerState | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    try {
      // POST /state — agent writes its state here (called from inside a
      // Temporal activity every heartbeat).
      if (url.pathname === "/state" && request.method === "POST") {
        const body = await request.json() as Partial<WorkerState>;
        return await this.writeState(body);
      }

      // GET /state — controller reads current state.
      if (url.pathname === "/state" && request.method === "GET") {
        return await this.readState();
      }

      // DELETE /state — agent is gone; mark offline.
      if (url.pathname === "/state" && request.method === "DELETE") {
        return await this.markOffline();
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error("WorkerStateDO error", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async writeState(body: Partial<WorkerState>): Promise<Response> {
    // Merge with existing state to preserve fields the agent didn't
    // include in the heartbeat.
    const now = new Date().toISOString();
    this.state = {
      workerId: body.workerId ?? this.state?.workerId ?? "unknown",
      region: body.region ?? this.state?.region ?? "unknown",
      status: body.status ?? this.state?.status ?? "idle",
      currentVmId: body.currentVmId ?? this.state?.currentVmId,
      capacity: body.capacity ?? this.state?.capacity ?? { cpuTotal: 0, cpuUsed: 0, memTotalMb: 0, memUsedMb: 0 },
      lastSeen: now,
      workflowCount: body.workflowCount ?? this.state?.workflowCount ?? 0,
      version: body.version ?? this.state?.version,
    };

    // Persist the state. In-memory storage is sufficient for live state;
    // durability is provided by DO's single-instance guarantee.
    await this.ctx.storage.put("state", this.state);
    return new Response(JSON.stringify({ ok: true, lastSeen: now }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async readState(): Promise<Response> {
    if (!this.state) {
      // Lazy-load from durable storage if the in-memory copy is gone
      // (e.g. after a DO eviction).
      this.state = await this.ctx.storage.get<WorkerState>("state") ?? null;
    }
    if (!this.state) {
      return new Response(JSON.stringify({ error: "worker not registered" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(this.state), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private async markOffline(): Promise<Response> {
    if (this.state) {
      this.state = {
        ...this.state,
        status: "offline",
        lastSeen: new Date().toISOString(),
      };
      await this.ctx.storage.put("state", this.state);
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
}
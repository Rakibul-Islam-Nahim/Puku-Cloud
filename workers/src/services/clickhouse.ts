/**
 * D1-backed analytics sink.
 *
 * Replaces the previous ClickHouse sink. Each `push()` writes one row to
 * the `audit_log` table (defined in workers/migrations/0001_initial.sql).
 * The dashboard's activity feed already reads from this table, so this
 * keeps a single source of truth for "what happened" without dragging a
 * second analytics store into the picture.
 *
 * Best-effort: errors are caught and logged. They never block the route
 * handler that called them.
 */

import type { Env } from "../types/env.ts";

export interface AnalyticsRow {
  ts: number; // unix seconds
  org_id?: string;
  sandbox_id?: string;
  database_id?: string;
  kind: string;
  payload: Record<string, unknown>;
}

class D1AnalyticsSink {
  push(env: Env, row: AnalyticsRow): void {
    // Fire-and-forget. We don't await so the route handler isn't slowed
    // down by the audit-log write.
    void this.write(env, row).catch((e) => {
      console.warn("d1 audit sink failed", e);
    });
  }

  private async write(env: Env, row: AnalyticsRow): Promise<void> {
    if (!env.DB) return;
    const action = row.kind;
    const details = JSON.stringify(row.payload ?? {});
    await env.DB.prepare(
      `INSERT INTO audit_log (ts, org_id, actor, action, workflow_id, details_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(
        row.ts,
        row.org_id ?? "",
        "system",
        action,
        row.sandbox_id ?? row.database_id ?? null,
        details,
      )
      .run();
  }

  /** No-op flush kept for the export surface; D1 writes are immediate. */
  async flush(_env: Env): Promise<void> {}

  /** No-op flush kept for the export surface; D1 writes are immediate. */
  async maybeFlush(_env: Env): Promise<void> {}
}

const g = globalThis as unknown as { __d1Sink?: D1AnalyticsSink };
export function getSink(): D1AnalyticsSink {
  if (!g.__d1Sink) g.__d1Sink = new D1AnalyticsSink();
  return g.__d1Sink;
}
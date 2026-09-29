/**
 * ClickHouse Cloud sink — drop-in replacement for the self-hosted ClickHouse
 * container that `docker-compose.dev.yml` brings up.
 *
 * Mirrors `api/internal/clickhouse/client.go` semantics:
 *   - JSONEachRow over HTTPS
 *   - batch up to 256 rows or 5s, whichever first
 *   - ring buffer 4096 (we use a single-worker in-memory buffer)
 *   - drop on failure (best-effort)
 *
 * On Workers, we don't have a long-lived process so we batch inside a single
 * invocation: a route handler pushes rows into the buffer; we flush when
 * (a) the buffer reaches 256 rows, or (b) the Worker is about to be torn down
 * (best-effort, not guaranteed).
 */
import type { Env } from "../types/env.ts";

export interface AnalyticsRow {
  ts: number;
  org_id?: string;
  sandbox_id?: string;
  database_id?: string;
  kind: string;
  payload: Record<string, unknown>;
}

const TABLE = "pukucloud.events";

class ClickHouseSink {
  private buffer: AnalyticsRow[] = [];
  private lastFlush = Date.now();

  push(env: Env, row: AnalyticsRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= 256) {
      // Don't await — best-effort.
      this.flush(env).catch((e) => console.warn("clickhouse flush failed", e));
    }
  }

  async flush(env: Env): Promise<void> {
    if (this.buffer.length === 0) return;
    if (!env.CLICKHOUSE_URL) return; // disabled
    const rows = this.buffer;
    this.buffer = [];
    this.lastFlush = Date.now();
    try {
      const body = rows.map((r) => JSON.stringify(toCH(r))).join("\n") + "\n";
      const url = `${env.CLICKHOUSE_URL.replace(/\/+$/, "")}/?query=${encodeURIComponent(
        `INSERT INTO ${TABLE} FORMAT JSONEachRow`
      )}`;
      const auth = "Basic " + btoa(`${env.CLICKHOUSE_USER ?? ""}:${env.CLICKHOUSE_PASSWORD ?? ""}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "authorization": auth, "content-type": "application/json; charset=utf-8" },
        body,
      });
      if (!res.ok) {
        // Drop on failure — log and continue.
        console.warn(`clickhouse insert ${res.status}: ${await res.text()}`);
      }
    } catch (e) {
      console.warn("clickhouse insert error", (e as Error).message);
    }
  }

  /** Idle check used by route handlers to flush mid-request. */
  async maybeFlush(env: Env): Promise<void> {
    if (Date.now() - this.lastFlush > 5_000 && this.buffer.length > 0) {
      await this.flush(env);
    }
  }
}

function toCH(r: AnalyticsRow): Record<string, unknown> {
  return {
    ts: r.ts,
    org_id: r.org_id ?? "",
    sandbox_id: r.sandbox_id ?? "",
    database_id: r.database_id ?? "",
    kind: r.kind,
    payload: JSON.stringify(r.payload),
  };
}

/** Singleton per isolate — survives across requests in the same isolate. */
const g = globalThis as unknown as { __chSink?: ClickHouseSink };
export function getSink(): ClickHouseSink {
  if (!g.__chSink) g.__chSink = new ClickHouseSink();
  return g.__chSink;
}

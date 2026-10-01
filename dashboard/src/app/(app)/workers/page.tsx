// SPDX-License-Identifier: Apache-2.0
"use client";

import { useCallback, useEffect, useState } from "react";
import { Cpu, RefreshCw } from "lucide-react";
import { listWorkers, type WorkerState } from "@/lib/api";
import { Badge, Btn, Card, PageHeader } from "@/components/ui";
import { RelativeTime } from "@/components/list-quality";

/**
 * Workers page.
 *
 * Lists every bare-metal agent that has heartbeated to the controller in
 * the last ~30 s and shows their live state (status, current VM, capacity).
 * Polls every 5 seconds.
 *
 * Data flow: GET /v1/workers → controller reads the D1 manifest for the
 * worker-id list, then fetches each DO in parallel for live state. The DO
 * is the source of truth for strongly-consistent per-agent state; the
 * manifest is just the index.
 */
export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerState[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await listWorkers();
      setWorkers(res.workers);
      setLastFetched(new Date());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  const summary = summarize(workers);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workers"
        description="Live state of every agent connected to the control plane. Polled every 5 seconds."
        actions={
          <div className="flex items-center gap-2">
            {lastFetched && (
              <span className="text-xs text-[var(--text-muted)]">
                updated {lastFetched.toLocaleTimeString()}
              </span>
            )}
            <Btn variant="secondary" onClick={() => void load()}>
              <RefreshCw size={13} className="mr-1" /> refresh
            </Btn>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Agents" value={summary.total} />
        <Stat label="Online" value={summary.online} tone="running" />
        <Stat label="Busy / Launching" value={summary.busy} tone="creating" />
        <Stat label="Draining / Offline" value={summary.draining} tone="failed" />
      </div>

      {err && (
        <Card>
          <div className="px-4 py-3 text-sm text-amber-300">{err}</div>
        </Card>
      )}

      <Card>
        <div className="px-4 py-3 text-[13px] font-medium" style={{ borderBottom: "1px solid var(--bg-overlay)", color: "var(--text-primary)" }}>
          {workers ? `${workers.length} agent${workers.length === 1 ? "" : "s"}` : "Loading…"}
        </div>
        {!workers || workers.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm" style={{ color: "var(--text-muted)" }}>
            {loading ? "Loading workers…" : "No agents have reported in. Start an agent with TEMPORAL_ADDRESS set to the control plane's Temporal server."}
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: "var(--bg-overlay)" }}>
            {workers.map((w) => (
              <WorkerRow key={w.worker_id} worker={w} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function WorkerRow({ worker }: { worker: WorkerState }) {
  const statusTone =
    worker.status === "busy" || worker.status === "launching"
      ? "creating"
      : worker.status === "draining" || worker.status === "offline"
        ? "failed"
        : "running";

  const memPct = worker.capacity.mem_total_mb > 0
    ? Math.round((worker.capacity.mem_used_mb / worker.capacity.mem_total_mb) * 100)
    : 0;
  const cpuPct = worker.capacity.cpu_total > 0
    ? Math.round((worker.capacity.cpu_used / worker.capacity.cpu_total) * 100)
    : 0;

  return (
    <div className="flex items-center gap-4 py-3 px-4">
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Cpu size={14} className="shrink-0" style={{ color: "var(--text-muted)" }} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium truncate" style={{ color: "var(--text-primary)" }}>
              {worker.worker_id}
            </span>
            <Badge tone={statusTone}>{worker.status}</Badge>
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: "var(--text-muted)" }}>
            region {worker.region || "unknown"}
            {worker.current_vm_id ? ` • vm ${worker.current_vm_id}` : ""}
            {worker.version ? ` • ${worker.version}` : ""}
          </div>
        </div>
      </div>

      <div className="hidden md:flex flex-col gap-1 w-48">
        <Bar label="CPU" pct={cpuPct} detail={`${worker.capacity.cpu_used}/${worker.capacity.cpu_total} cores`} />
        <Bar label="mem" pct={memPct} detail={`${formatMb(worker.capacity.mem_used_mb)} / ${formatMb(worker.capacity.mem_total_mb)} MB`} />
      </div>

      <div className="text-right text-[11px] shrink-0" style={{ color: "var(--text-muted)" }}>
        <RelativeTime value={worker.last_seen} />
      </div>
    </div>
  );
}

function Bar({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const tone = pct >= 90 ? "var(--status-failed)" : pct >= 70 ? "var(--status-paused)" : "var(--status-running)";
  return (
    <div>
      <div className="flex items-center justify-between text-[10px]" style={{ color: "var(--text-muted)" }}>
        <span>{label}</span>
        <span>{detail}</span>
      </div>
      <div className="h-1.5 rounded-full mt-0.5" style={{ background: "var(--bg-overlay)" }}>
        <div
          className="h-1.5 rounded-full"
          style={{ width: `${Math.min(pct, 100)}%`, background: tone }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "running" | "creating" | "failed" }) {
  const color = tone === "running"
    ? "var(--status-running)"
    : tone === "creating"
      ? "var(--status-creating)"
      : tone === "failed"
        ? "var(--status-failed)"
        : "var(--text-primary)";
  return (
    <Card>
      <div className="px-4 py-3">
        <div className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          {label}
        </div>
        <div className="text-2xl font-semibold mt-1" style={{ color }}>
          {value}
        </div>
      </div>
    </Card>
  );
}

function summarize(workers: WorkerState[] | null) {
  if (!workers) {
    return { total: 0, online: 0, busy: 0, draining: 0 };
  }
  let online = 0, busy = 0, draining = 0;
  for (const w of workers) {
    if (w.status === "busy" || w.status === "launching") busy++;
    else if (w.status === "draining" || w.status === "offline") draining++;
    else online++;
  }
  return { total: workers.length, online, busy, draining };
}

function formatMb(n: number): string {
  if (n >= 1024) return (n / 1024).toFixed(1) + "G";
  return `${n}`;
}
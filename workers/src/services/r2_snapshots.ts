/**
 * R2-backed snapshot store.
 *
 * Replaces the GCS Range-GET path that the agent's `memstream` and
 * `diskstream` resolvers use today. R2 supports byte-range GETs natively
 * and charges no egress to Cloudflare, which makes it the right backing
 * store once the control plane and dashboards live on CF.
 *
 * Two operation modes:
 *   - "presign": return a short-lived signed URL the agent can fetch directly.
 *     Cheapest, no double-egress. Requires `secrets.R2_SNAPSHOT_TOKEN`.
 *   - "proxy":   the Worker streams the Range GET to the agent on its behalf.
 *     Works without a presign key but doubles the egress.
 *
 * Layout in the bucket (mirror of what `seed-sync` writes today):
 *   templates/<name>/vm.mem
 *   templates/<name>/vmstate
 *   templates/<name>/rootfs.ext4
 *   snapshots/<sandbox-id>/<snap-id>/vm.mem
 *   snapshots/<sandbox-id>/<snap-id>/vmstate
 *   snapshots/<sandbox-id>/<snap-id>/rootfs.ext4
 *   volumes/<name>/ext4.vol
 */
import type { Env } from "../types/env.ts";

export type SnapshotKind = "template" | "snapshot" | "volume";

export interface ResolveOpts {
  kind: SnapshotKind;
  template?: string;
  sandboxId?: string;
  snapshotId?: string;
  volume?: string;
  /** Which file: vm.mem, vmstate, rootfs.ext4, ext4.vol */
  file: "vm.mem" | "vmstate" | "rootfs.ext4" | "ext4.vol";
}

export interface ResolvedRange {
  url: string;          // absolute URL the agent fetches
  key: string;          // R2 object key
  byteStart: number;    // resolved byte range
  byteEnd: number;
  totalBytes: number;
  mode: "presign" | "proxy";
}

export function r2Key(opts: ResolveOpts): string {
  switch (opts.kind) {
    case "template":
      if (!opts.template) throw new Error("template required");
      return `templates/${opts.template}/${opts.file}`;
    case "snapshot":
      if (!opts.sandboxId || !opts.snapshotId) throw new Error("sandboxId + snapshotId required");
      return `snapshots/${opts.sandboxId}/${opts.snapshotId}/${opts.file}`;
    case "volume":
      if (!opts.volume) throw new Error("volume required");
      return `volumes/${opts.volume}/${opts.file}`;
  }
}

export async function headSnapshot(env: Env, key: string): Promise<{ size: number } | null> {
  const obj = await env.SNAPSHOTS.head(key);
  if (!obj) return null;
  return { size: obj.size };
}

/**
 * Resolve a byte-range request into a URL the agent can GET.
 *
 * @param opts what to read
 * @param range "bytes=START-END" or null for whole object
 */
export async function resolveRange(env: Env, opts: ResolveOpts, range?: string | null): Promise<ResolvedRange> {
  const key = r2Key(opts);
  const meta = await headSnapshot(env, key);
  if (!meta) throw new SnapshotNotFound(key);

  let byteStart = 0;
  let byteEnd = meta.size - 1;
  if (range) {
    const m = /^bytes=(\d+)-(\d+)?$/.exec(range.trim());
    if (!m) throw new RangeNotSatisfiable(`bad range header: ${range}`);
    byteStart = parseInt(m[1]!, 10);
    byteEnd = m[2] ? Math.min(parseInt(m[2], 10), meta.size - 1) : meta.size - 1;
    if (byteStart >= meta.size) throw new RangeNotSatisfiable(`start ${byteStart} >= size ${meta.size}`);
  }

  if (env.R2_SNAPSHOT_TOKEN) {
    const url = await presignedGetUrl(env, key, byteStart, byteEnd);
    return { url, key, byteStart, byteEnd, totalBytes: meta.size, mode: "presign" };
  }
  // Fallback: hand back a Worker URL that streams the range back to the agent.
  const qs = new URLSearchParams({ key, start: String(byteStart), end: String(byteEnd) });
  const url = `${new URL(env.PUKUCLOUD_DASHBOARD_URL).origin}/v1/internal/r2/range?${qs}`;
  return { url, key, byteStart, byteEnd, totalBytes: meta.size, mode: "proxy" };
}

async function presignedGetUrl(env: Env, key: string, start: number, end: number): Promise<string> {
  // Presign mode is opt-in. To keep the dependency surface small we don't
  // bundle the AWS SDK — instead we hit R2's native S3-compatible signing
  // helper via a Worker-to-Worker fetch when R2_PRESIGN_URL is set
  // (e.g. pointing at a thin signing service or the R2 S3 API directly).
  // If you need SDK-style presigning, add `@aws-sdk/client-s3` and
  // `@aws-sdk/s3-request-presigner` and replace this body.
  const presignHelper = (env as unknown as { R2_PRESIGN_URL?: string }).R2_PRESIGN_URL;
  if (!presignHelper) {
    throw new Error("R2 presign mode requested but R2_PRESIGN_URL is not set");
  }
  const url = new URL(presignHelper);
  url.searchParams.set("key", key);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.R2_SNAPSHOT_TOKEN ?? ""}` },
  });
  if (!res.ok) throw new Error(`presign helper failed: ${res.status}`);
  const { url: signed } = await res.json() as { url: string };
  return signed;
}

export class SnapshotNotFound extends Error {
  constructor(public key: string) {
    super(`snapshot not found: ${key}`);
    this.name = "SnapshotNotFound";
  }
}

export class RangeNotSatisfiable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RangeNotSatisfiable";
  }
}

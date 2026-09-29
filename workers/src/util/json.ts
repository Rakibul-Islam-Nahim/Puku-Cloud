export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, replacer), { ...init, headers });
}

export function err(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code, message, ...extra } }, { status });
}

function replacer(_k: string, v: unknown): unknown {
  // Stable bigint handling — D1 returns unix seconds as integer, this is a no-op today but future-proofs.
  if (typeof v === "bigint") return Number(v);
  return v;
}

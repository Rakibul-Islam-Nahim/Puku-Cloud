#!/usr/bin/env -S npx tsx
export {};
/**
 * Apply Cloudflare Spectrum config that fronts db-proxy.
 *
 * Spectrum is Cloudflare's L4 reverse proxy — it forwards raw TCP (or UDP)
 * while preserving the original TLS SNI on the way out, which is exactly
 * what the db-proxy in /home/rakib/intern/sagorBhai/pukucloud-ai/db-proxy
 * needs in order to discover the sandbox id from the SNI label.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... \
 *   CLOUDFLARE_ACCOUNT_ID=... \
 *   CLOUDFLARE_ZONE_ID=... \
 *   DB_PROXY_ORIGIN="203.0.113.42:5432" \
 *   DB_PROXY_HOSTNAME="db.example.com" \
 *   npx tsx scripts/cf-spectrum.ts
 *
 * Idempotent: re-running with the same hostname updates the existing spectrum
 * app instead of creating a duplicate.
 */
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const ZONE = process.env.CLOUDFLARE_ZONE_ID;
const ORIGIN = process.env.DB_PROXY_ORIGIN;
const HOST = process.env.DB_PROXY_HOSTNAME;
if (!TOKEN || !ACCOUNT || !ZONE || !ORIGIN || !HOST) {
  console.error("missing one of: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, DB_PROXY_ORIGIN, DB_PROXY_HOSTNAME");
  process.exit(2);
}

const api = (path: string, init?: RequestInit) =>
  fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      "authorization": `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

// 1. Find existing spectrum app on this zone, if any.
const list = await api(`/zones/${ZONE}/spectrum/apps`);
const j = await list.json() as { result: Array<{ id: string; dns: { type: string; name: string } }> };
const existing = j.result.find((a) => a.dns?.name === HOST);

const body = {
  protocol: "tls",
  dns: { type: "CNAME", name: HOST },
  origin_direct: [ORIGIN],
  tls: { min_version: "1.2" },
  ip_firewall: false,
  proxy_protocol: false,
  traffic_type: "direct",
};

let res: Response;
if (existing) {
  res = await api(`/zones/${ZONE}/spectrum/apps/${existing.id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
} else {
  res = await api(`/zones/${ZONE}/spectrum/apps`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const out = await res.json() as { success: boolean; result?: { id: string }; errors?: unknown[] };
if (!out.success) {
  console.error("spectrum apply failed", out.errors);
  process.exit(1);
}
console.log(`spectrum ${existing ? "updated" : "created"}: ${out.result!.id} → ${HOST} (origin ${ORIGIN})`);

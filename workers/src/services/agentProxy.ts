/**
 * Reverse-proxy to the agent fleet.
 *
 * Mirrors the Go API's `httputil.NewSingleHostReverseProxy` + `MultiNodeDirector`
 * behaviour: every `/v1/...` request that isn't handled by a control-plane
 * route is forwarded to the agent. We strip the `/v1` prefix (because the
 * agent's router is mounted at `/`) and the `?access_token=` query param
 * (replaced by `Authorization: Bearer` for the agent hop).
 *
 * Multi-node selection is handled by `pickAgent()` (round-robin by key for v1;
 * the Go scheduler does capacity scoring — drop in a richer selector later).
 */
import type { Env } from "../types/env.ts";
import { pickAgent, listAgents } from "../util/agents.ts";

export interface ProxyOpts {
  /** Sandbox / database id used as the routing key (stable hash → same agent). */
  routingKey?: string;
  /** Override agent base URL (bypasses scheduler). */
  forceAgent?: string;
}

export async function proxyToAgent(req: Request, env: Env, opts: ProxyOpts = {}): Promise<Response> {
  const baseRaw = opts.forceAgent ?? pickAgent(env, opts.routingKey);
  const base = baseRaw.replace(/\/+$/, "");
  const incomingUrl = new URL(req.url);
  // Strip the leading /v1 prefix — agent router is mounted at /.
  const agentPath = incomingUrl.pathname.replace(/^\/v1/, "") || "/";

  // Strip access_token from query string.
  const qs = new URLSearchParams(incomingUrl.search);
  qs.delete("access_token");
  const qsStr = qs.toString();
  const targetUrl = `${base}${agentPath}${qsStr ? "?" + qsStr : ""}`;

  const headers = new Headers(req.headers);
  // Hop-by-hop headers must not be forwarded.
  headers.delete("connection");
  headers.delete("keep-alive");
  headers.delete("proxy-authenticate");
  headers.delete("proxy-authorization");
  headers.delete("te");
  headers.delete("trailers");
  headers.delete("transfer-encoding");
  headers.delete("upgrade");        // WS upgrade is handled by /v1/databases/{id}/proxy below
  headers.delete("host");
  headers.set("host", new URL(base).host);
  if (env.PUKUCLOUD_AGENT_TOKEN) {
    headers.set("authorization", `Bearer ${env.PUKUCLOUD_AGENT_TOKEN}`);
  }
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-pukucloud-control-plane", "cloudflare-workers");

  return await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.body,
    // Workers' fetch streams — `duplex` is required when sending a body.
    // @ts-expect-error — TS lib doesn't know about duplex yet
    duplex: "half",
  });
}

export { listAgents };

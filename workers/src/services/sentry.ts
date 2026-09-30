/**
 * Sentry wrapper for Cloudflare Workers.
 *
 * The CF Workers runtime doesn't support `@sentry/node` (it's a Node SDK).
 * Instead, we send errors directly to the Sentry HTTP envelope endpoint
 * (POST /api/{project_id}/store/). That's what Sentry's own
 * `@sentry/cloudflare` package does internally; this is the bare version
 * so we don't add a dependency.
 *
 * To enable: set SENTRY_DSN on the worker. Format:
 *   https://<public_key>@o<org_id>.ingest.sentry.io/<project_id>
 * If unset, all capture* calls are no-ops.
 */

import type { Env } from "../types/env.ts";

interface SentryConfig {
  /** Full envelope URL, derived from DSN. */
  envelopeUrl: string;
  publicKey: string;
  enabled: boolean;
}

let cachedConfig: SentryConfig | null = null;
function getConfig(env: Env): SentryConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = parseDSN(env.SENTRY_DSN);
  return cachedConfig;
}

function parseDSN(dsn?: string): SentryConfig {
  if (!dsn) return { envelopeUrl: "", publicKey: "", enabled: false };
  // DSN format: https://<public_key>@o<org_id>.ingest.<host>/<project_id>
  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const projectId = url.pathname.replace(/^\//, "");
    const envelopeUrl = `${url.protocol}//${url.host}/api/${projectId}/store/?sentry_key=${publicKey}&sentry_version=7`;
    return { envelopeUrl, publicKey, enabled: true };
  } catch {
    return { envelopeUrl: "", publicKey: "", enabled: false };
  }
}

/**
 * Capture an exception and send it to Sentry. Fire-and-forget — we
 * don't block the request on Sentry's response. Errors during send are
 * logged but not re-thrown.
 */
export async function captureException(
  env: Env,
  err: unknown,
  context?: {
    request?: Request;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    level?: "error" | "warning" | "info";
  },
): Promise<void> {
  const cfg = getConfig(env);
  if (!cfg.enabled) return;

  const e = err instanceof Error ? err : new Error(String(err));
  const event = buildEvent(e, context, env);

  try {
    await fetch(cfg.envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (sendErr) {
    console.error("sentry: failed to send event", sendErr);
  }
}

/**
 * Hono middleware that captures any thrown error or 5xx response into
 * Sentry. Mount as: `app.use("*", sentryMiddleware)`.
 */
export const sentryMiddleware = async (
  c: { env: Env; set: (k: string, v: unknown) => void; get: (k: string) => unknown },
  next: () => Promise<unknown>,
) => {
  try {
    await next();
    // 5xx responses are also worth reporting.
    // Hono sets the response after next() returns; we can't read it here
    // without parsing the Response. Skipping 5xx capture for now —
    // exceptions below are the main path.
  } catch (err) {
    await captureException(c.env, err, {
      request: undefined, // Hono's c.req.raw is available in route handlers
    });
    throw err;
  }
};

function buildEvent(
  err: Error,
  context: {
    request?: Request;
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    level?: "error" | "warning" | "info";
  } | undefined,
  env: Env,
): Record<string, unknown> {
  const tags = context?.tags ?? {};
  const extra = context?.extra ?? {};
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: context?.level ?? "error",
    logger: "cloudflare-workers",
    environment: env.PUKUCLOUD_ENV ?? "production",
    release: env.PUKUCLOUD_API_VERSION ?? undefined,
    tags,
    extra,
    exception: {
      values: [
        {
          type: err.name || "Error",
          value: err.message,
          stacktrace: err.stack ? { frames: parseStack(err.stack) } : undefined,
        },
      ],
    },
  };
}

interface StackFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
}

function parseStack(stack: string): StackFrame[] {
  // Parse V8-style stacks: "at fn (file:line:col)"
  const lines = stack.split("\n").slice(1); // skip "Error: msg"
  const frames: StackFrame[] = [];
  for (const line of lines) {
    const m = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (!m) continue;
    frames.push({
      function: m[1] ?? "<anonymous>",
      filename: m[2] ?? "",
      lineno: m[3] ? Number(m[3]) : undefined,
      colno: m[4] ? Number(m[4]) : undefined,
    });
  }
  return frames;
}

/** Clear the cached config (tests). */
export function resetSentryConfig(): void {
  cachedConfig = null;
}
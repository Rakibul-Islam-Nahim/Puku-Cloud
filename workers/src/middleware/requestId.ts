import type { MiddlewareHandler } from "hono";
import { ulid } from "../util/ulid.ts";

/** Tag every request with X-Request-Id (server-side) and an `executionCtx.waitUntil` log line. */
export const requestId: MiddlewareHandler<{ Variables: { requestId: string } }> = async (c, next) => {
  const id = c.req.header("x-request-id") ?? ulid("req");
  c.set("requestId", id);
  c.header("x-request-id", id);
  const start = Date.now();
  await next();
  // Fire-and-forget structured log line.
  console.log(JSON.stringify({
    level: "info",
    msg: "request",
    requestId: id,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
  }));
};

import { describe, it, expect } from "vitest";
import app from "../src/index.ts";
import type { Env } from "../src/types/env.ts";

describe("health endpoints", () => {
  it("GET /healthz returns ok", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/healthz");
    const res = await app.fetch(req, env, makeCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /version returns runtime info", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/version");
    const res = await app.fetch(req, env, makeCtx());
    expect(res.status).toBe(200);
    const j = await res.json() as { runtime: string; env: string };
    expect(j.runtime).toBe("cloudflare-workers");
  });

  it("rejects unknown paths", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/nope");
    const res = await app.fetch(req, env, makeCtx());
    expect(res.status).toBe(404);
  });
});

function makeEnv(): Env {
  return {
    PUKUCLOUD_ENV: "test",
    PUKUCLOUD_API_VERSION: "0.0.0",
    PUKUCLOUD_AGENT_URLS: "",
    PUKUCLOUD_DASHBOARD_URL: "https://example.com",
    DB: {} as D1Database,
    SNAPSHOTS: {} as R2Bucket,
    CACHE: {} as KVNamespace,
    AUTH_MODE: "stub",
  };
}

function makeCtx(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

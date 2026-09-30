import { describe, it, expect, vi, beforeEach } from "vitest";
import { temporalConfig, startWorkflow, describeWorkflow, cancelWorkflow, signalWorkflow, TemporalError } from "../src/services/temporal";

// Mock fetch so we can run unit tests without a real Temporal server.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

const baseEnv = {
  PUKUCLOUD_ENV: "test",
  PUKUCLOUD_API_VERSION: "0.1.0",
  PUKUCLOUD_AGENT_URLS: "",
  PUKUCLOUD_DASHBOARD_URL: "",
  TEMPORAL_ADDRESS: "http://temporal.test:8233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test-queue",
  DB: {} as D1Database,
  SNAPSHOTS: {} as R2Bucket,
  CACHE: {} as KVNamespace,
};

describe("services/temporal", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  describe("temporalConfig", () => {
    it("reads address and namespace from env", () => {
      const cfg = temporalConfig(baseEnv);
      expect(cfg.baseUrl).toBe("http://temporal.test:8233");
      expect(cfg.namespace).toBe("default");
    });

    it("falls back to localhost:8233 when unset", () => {
      const cfg = temporalConfig({ ...baseEnv, TEMPORAL_ADDRESS: undefined });
      expect(cfg.baseUrl).toBe("http://localhost:8233");
    });

    it("strips trailing slash from baseUrl", () => {
      const cfg = temporalConfig({ ...baseEnv, TEMPORAL_ADDRESS: "http://temporal:8233/" });
      expect(cfg.baseUrl).toBe("http://temporal:8233");
    });
  });

  describe("startWorkflow", () => {
    it("POSTs to the Temporal HTTP API", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 201 }));
      const id = await startWorkflow(baseEnv, {
        workflowType: "LaunchMicroVMWorkflow",
        workflowId: "wf-1",
        taskQueue: "q",
        input: { hello: "world" },
      });
      expect(id).toBe("wf-1");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://temporal.test:8233/api/v1/namespaces/default/workflows");
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.workflow_id).toBe("wf-1");
      expect(body.workflow_type.name).toBe("LaunchMicroVMWorkflow");
      expect(body.task_queue.name).toBe("q");
      expect(body.request_id).toBe("wf-1");
    });

    it("throws TemporalError on non-2xx", async () => {
      fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 503 }));
      await expect(
        startWorkflow(baseEnv, { workflowType: "X", workflowId: "y", taskQueue: "q", input: {} }),
      ).rejects.toThrow(TemporalError);
    });
  });

  describe("describeWorkflow", () => {
    it("parses workflowExecutionInfo", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflowExecutionInfo: {
              workflowId: "wf-1",
              runId: "run-1",
              type: { name: "LaunchMicroVMWorkflow" },
              status: "Running",
              startTime: "2026-09-30T00:00:00Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const info = await describeWorkflow(baseEnv, "wf-1");
      expect(info.workflowId).toBe("wf-1");
      expect(info.status).toBe("Running");
    });

    it("throws TemporalError with status 404 when not found", async () => {
      fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
      await expect(describeWorkflow(baseEnv, "wf-1")).rejects.toThrow(/not found/);
    });
  });

  describe("signalWorkflow", () => {
    it("POSTs to the signal endpoint", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      await signalWorkflow(baseEnv, { workflowId: "wf-1", signalName: "cancel", input: { reason: "user" } });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/workflows/wf-1/signals/cancel");
      expect(init.method).toBe("POST");
    });
  });

  describe("cancelWorkflow", () => {
    it("POSTs to the cancel endpoint", async () => {
      fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
      await cancelWorkflow(baseEnv, "wf-1");
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("/workflows/wf-1/cancel");
      expect(init.method).toBe("POST");
    });
  });
});
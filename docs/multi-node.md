# Multi-node PukuCloud

How to run more than one agent behind the same control plane — what the
edge does, how agents register, where state lives, and how to add or remove
a node without losing sandboxes.

For the high-level picture see [architecture.md § Multi-node topology](architecture.md#multi-node-topology). This doc is the operator walkthrough.

## Contents

- [How multi-node is wired](#how-multi-node-is-wired)
- [The single switch: `TEMPORAL_ADDRESS`](#the-single-switch-temporal_address)
- [Agent registration and heartbeats](#agent-registration-and-heartbeats)
- [Scheduler: Temporal task queues](#scheduler-temporal-task-queues)
- [Pools: `stateful` vs `ephemeral`](#pools-stateful-vs-ephemeral)
- [Burst-spread and the 2026-08-22 incident](#burst-spread-and-the-2026-08-22-incident)
- [Adding a node](#adding-a-node)
- [Removing a node (drain)](#removing-a-node-drain)
- [Failure handling](#failure-handling)
- [Known gaps](#known-gaps)
- [Verifying it works locally](#verifying-it-works-locally)

---

## How multi-node is wired

Three things have to exist for multi-node:

1. **A shared Temporal server** reachable from every controller process and
   every agent process. Workflows live in Temporal's history; the agents
   poll task queues. The CF Worker talks to Temporal over its HTTP API
   (port 8233) since CF Workers cannot open arbitrary TCP.
2. **The controller** (the CF Worker) — starts workflows and exposes the
   public API.
3. **One or more agent hosts**. Each agent polls Temporal's
   `pukucloud-microvms` task queue and heartbeats its live state to the
   controller's `WorkerStateDO` every 10 s.

When `TEMPORAL_ADDRESS` is **unset**, the controller's sandbox routes
fall back to the legacy agent-direct proxy (`PUKUCLOUD_AGENT_URLS`). When
it is set, workflows route through Temporal and agents become
indistinguishable from the caller's point of view — same `/v1/sandboxes`,
same `/v1/sandboxes/{id}/exec`, etc.

There is exactly **one** environment variable that flips the mode.
Everything else scales from there.

---

## The single switch: `TEMPORAL_ADDRESS`

```
# Single-node (legacy): unset or empty.
agent:               ./agent            # listens on a unix socket
controller:          wrangler dev       # proxies /v1/* to the unix socket

# Multi-node (Temporal): set on every agent + on the controller.
TEMPORAL_ADDRESS=temporal.internal:7233
TEMPORAL_TASK_QUEUE=pukucloud-microvms
agent-N:             ./agent --listen-tcp :7070   # polls Temporal
```

The controller also needs `PUKUCLOUD_AGENT_TOKEN` set so it can authenticate
agents that connect to `/v1/internal/agents/:worker_id/state` for heartbeats.
The token is shared between controller and fleet (not per-user auth).
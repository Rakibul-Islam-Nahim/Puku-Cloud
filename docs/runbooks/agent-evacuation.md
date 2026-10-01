# Agent evacuation

How to drain a single bare-metal agent so it can be replaced or
decommissioned without dropping in-flight work.

## When to evacuate

- A host has flaky network or storage (KVM warnings in dmesg).
- A kernel update requires a reboot and you can't risk the auto-recovery
  losing persistent VMs.
- The host is being decommissioned (hardware refresh, region change).

## What "drained" means

A drained agent:
- Stops being picked by Temporal's task-queue scheduler (new workflows
  route to other agents).
- Lets in-flight activities finish naturally — including multi-minute
  snapshot restores.
- Marks itself `status: draining` on the WorkerStateDO so the dashboard
  warns operators.

It does NOT:
- Force-kill running microVMs (that risks the guest's disk).
- Snapshot itself mid-launch (the activity's normal path handles that).

## Procedure

1. **Trigger the drain**
   ```bash
   ssh agent-3.internal
   sudo systemctl stop pukucloud-agent
   ```
   The agent's shutdown handler waits up to
   `PUKUCLOUD_HIBERNATE_BUDGET_SECONDS` (default 120 s) for persistent
   sandboxes to finish hibernating. Then the process exits.

2. **Verify the host is removed from the scheduler**
   ```bash
   # in another shell — should show all OTHER agents within ~10 s
   curl -fsS https://api.example.com/v1/workers | jq '.workers[] | {worker_id, status}'
   ```

3. **Confirm sandboxes moved**
   - New `LaunchMicroVM` activities should be picked by other agents.
   - The dashboard's `/workers` page should show one fewer agent, with
     the removed one's last-seen timestamp frozen.

4. **(Optional) Snapshot persistent VMs before rebooting**
   ```bash
   # already handled by the graceful shutdown, but if you need a hard
   # guarantee before a kernel update:
   ssh agent-3.internal
   sudo /usr/local/bin/pukucloud-agent -snapshot-all -data-dir=/var/lib/pukucloud
   ```

5. **Reboot / replace the host**
   ```bash
   sudo reboot
   ```

6. **(Optional) Re-join the fleet**
   ```bash
   # on the new host:
   TEMPORAL_ADDRESS=temporal.prod:7233 \
   PUKUCLOUD_CONTROLLER_URL=https://api.example.com \
   PUKUCLOUD_AGENT_TOKEN=<shared-token> \
   systemctl start pukucloud-agent
   ```
   The new agent re-registers automatically; its first heartbeat creates
   a fresh WorkerStateDO.

## Rollback

If the drain was a mistake (operator was wrong, host is actually fine):

1. `systemctl start pukucloud-agent` on the host.
2. The agent re-subscribes to the task queue within 30 s. New workflows
   are routed to it again automatically — Temporal doesn't have a
   "permanently banned" state; absence is the ban.

## Force-quit (last resort)

If the agent's shutdown handler is stuck (waiting for an
uninterruptible snapshot) and you need the host back NOW:

```bash
ssh agent-3.internal
sudo systemctl kill -s SIGKILL pukucloud-agent
```

This skips the hibernate path. Persistent VMs on this host will fail
over on next connect via the db-proxy + db-broker. Non-persistent VMs
are lost (their state was on the host's local disk).
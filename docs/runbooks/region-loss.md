# Region loss

What to do when an entire region goes offline (data center outage,
cloud provider regional incident).

## Symptoms

- The dashboard's `/workers` page shows ALL agents in a region as
  `offline` (no heartbeats for > 30 s).
- `LaunchMicroVM` workflows time out with `activity worker disconnected`
  (Temporal UI).
- Cloud provider status page confirms a regional incident.

## Triage

1. **Confirm it's not your network**
   ```bash
   # from an external host
   for agent in agent-1.region-a.example.com agent-2.region-a.example.com; do
     curl -fsS --max-time 3 https://$agent/healthz && echo " — $agent OK"
   done
   ```

2. **Check the Temporal UI's worker task queue.**
   In `Workflows → Task queues`, the queue for the lost region should
   show `Pollers: 0/0`. If poller count is normal but workflows are stuck,
   the issue is different (consult `temporal-failover.md`).

3. **Check your routing layer.**
   If the controller is region-pinned via Cloudflare, look at the
   Workers → Logs → HTTP Errors page for `525` (TLS handshake) or `1033`
   (origin unreachable) spikes.

## What happens to in-flight work

- **In-flight activities** — Temporal will retry them after the
  `HeartbeatTimeout` (default 60 s for our workflows). On retry,
  Temporal re-routes to ANY poller in the task queue, which means a
  survivor region picks them up. So most work recovers automatically.

- **In-flight databases / persistent VMs** — Lost. The host's data
  disk is in the dead region. A new agent in a survivor region cannot
  attach the disk. To recover: restore from the most recent snapshot
  (R2 / S3) into a new VM in the survivor region. The dashboard's
  `/databases` page will show the DB as `failed`; restore via the API
  or via the dashboard's restore-from-snapshot button (if wired).

- **New sandbox creates** — Blocked until a survivor region has capacity
  to absorb them. If you auto-scale survivors (Phase 6 stretch goal),
  they spin up automatically.

## Immediate actions

1. **Free capacity in survivor regions.** Don't wait for the routing
   layer to rebalance; operators should:
   ```bash
   # drain low-priority workloads from survivor-1 first
   pukucloud-cli drain --worker survivor-1-low-prio
   ```
   (Replace with the operator's preferred way to mark an agent as
   `draining`; see `agent-evacuation.md` for the manual path.)

2. **Add capacity if needed.**
   ```bash
   # spin up new agents in the survivor region(s)
   terraform apply -var-file=survivor.tfvars
   # OR manually:
   ssh new-agent-host
   systemctl start pukucloud-agent
   ```

3. **Tell users.**
   - Pin a banner on the dashboard ("Region A is degraded; failover in
     progress") — use the dashboard's `/settings/orgs` page or a
     static `index.html` redirect if the dashboard itself is degraded.
   - Post a status update.

## Long-running recoveries

If the region will be down for > 1 hour, run a `drill` to migrate
persistent databases:

```bash
# list persistent VMs in the lost region
pukucloud-cli dbs list --region region-a --status running

# for each: snapshot + restore in a survivor region
for db in $(pukucloud-cli dbs list --region region-a --status running --format id); do
  pukucloud-cli dbs restore-from-snapshot \
    --id $db --target-region survivor-1 --latest-snapshot
done
```

## Post-incident

- **Verify snapshot coverage.** If a database was lost because the
  last snapshot was hours old, schedule snapshot cadence down to
  ≤ 15 min for production-managed databases.
- **Review the runbook.** What took longer than expected? Add it here.
- **Test failover quarterly.** Spin up a second cluster, take it down,
  and time the recovery. Add the result to this runbook.

## What doesn't work

- ❌ Trying to "wait it out" past 4 hours. Plan a real migration.
- ❌ Manually editing D1 to mark agents as active. They'll be marked
  offline again within seconds.
- ❌ SSHing into a lost region. The host is gone.
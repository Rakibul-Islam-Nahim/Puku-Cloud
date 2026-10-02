# Temporal failover

What to do when Temporal is unavailable and workflows stop being scheduled.

## Symptoms

- `LaunchMicroVM` activities stop progressing in the Temporal UI
- New sandbox creates return `workflow timeout` after the HeartbeatTimeout
  fires (60s by default)
- Agent logs contain: `temporal: server unavailable`, `connection refused`,
  or `TLS handshake error`
- The controller's `/v1/internal/agents/:id/state` heartbeats keep arriving,
  so agents themselves are fine — they're just idle

## Triage

1. **Is Temporal up?**
   ```bash
   curl -fsS http://temporal:8233/health
   # expect: {"status":"SERVING"}
   ```
   Or, if you've enabled TLS:
   ```bash
   curl -fsS --cacert /etc/temporal/certs/ca.crt \
     https://temporal:8233/health
   ```

2. **What's in the Temporal logs?**
   ```bash
   docker compose -f infra/temporal/docker-compose.yml logs --tail=200 temporal
   ```
   Look for `OOMKilled`, `panic`, or "namespace cert has expired".

3. **Is the bundled Postgres healthy?**
   ```bash
   docker compose -f infra/temporal/docker-compose.yml exec postgres \
     pg_isready -U temporal
   ```
   Postgres being unhealthy is the #1 cause of Temporal hangs after a host
   reboot (the WAL replay on a 50 GB DB can take 10+ minutes).

## Recovery

### Soft: Temporal hung but the process is up

```bash
docker compose -f infra/temporal/docker-compose.yml restart temporal
```

This re-establishes the connections to its history DB without losing
uncommitted workflow state. Pending activities resume automatically once
the worker task-queue subscriptions re-register (≤ 30 s).

### Soft: bundled Postgres out of disk

```bash
# Find which container is consuming the most WAL
docker compose -f infra/temporal/docker-compose.yml exec postgres \
  du -sh /var/lib/postgresql/data

# If you're out of room, expand the volume first, then postgres
docker compose -f infra/temporal/docker-compose.yml down postgres
# (resize the volume in your storage backend)
docker compose -f infra/temporal/docker-compose.yml up -d postgres
docker compose -f infra/temporal/docker-compose.yml up -d temporal
```

### Hard: Temporal VM is gone

1. Provision a replacement host.
2. Restore Postgres from the last nightly snapshot (see
   `docs/runbooks/backup-restore.md` if you have one — otherwise this
   is a cold start; pending workflows restart from scratch and
   in-flight activities retry from their last heartbeat).
3. Start Temporal pointing at the restored Postgres.
4. Restart the agents (they'll re-subscribe to the task queue within 30 s).

There is no single-node bypass. If Temporal is down, new sandbox creates time out at the controller's `StartWorkflow` deadline. Communicate the outage; do not operate the fleet in a degraded mode that bypasses Temporal.

## After recovery

- Confirm `/v1/workers` shows all agents back online within 60 s.
- Look at `failed` workflows in the Temporal UI — anything that failed
  during the outage will be there with a clear cause.
- Check Sentry for any workflow that errored mid-recovery and didn't
  retry cleanly.
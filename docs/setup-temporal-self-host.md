# Setup: Self-hosted Temporal + Sentry

PukuCloud's new orchestration layer runs on Temporal (workflows) and
Sentry (errors). Both can be self-hosted with the stacks in
`infra/temporal/` and `infra/sentry/`. This guide brings up the full
local stack.

## Bring up Temporal

```bash
cd infra/temporal
docker compose up -d
docker compose ps
# You should see:
# pukucloud-temporal            healthy
# pukucloud-temporal-postgres   healthy

# Health check:
curl http://localhost:8233/health
```

Web UI (optional):

```bash
docker compose --profile ui up -d
# open http://localhost:8080
```

## Bring up Sentry

```bash
# Generate a real secret key:
openssl rand -hex 32
# paste into SENTRY_SECRET_KEY in infra/sentry/docker-compose.yml

cd infra/sentry
docker compose up -d
# open http://localhost:9000 and finish the bootstrap wizard
# create a project for the Go agent (and another for the CF Worker)
# copy each project's DSN
```

## Configure the agent

Add these to the agent's environment (or to the systemd unit):

```bash
export TEMPORAL_ADDRESS="temporal.example.com:7233"
export TEMPORAL_NAMESPACE="default"
export TEMPORAL_TASK_QUEUE="pukucloud-microvms"
export SENTRY_DSN="https://abc123@sentry.example.com/1"
export PUKUCLOUD_ENV="production"
```

The agent process does the rest: dials Temporal, registers workflows +
activities, starts heartbeating. No IP allowlist updates needed.

## Configure the controller (Cloudflare Worker)

```bash
cd workers
# Add to .dev.vars or set with `wrangler secret put`:
wrangler secret put TEMPORAL_AUTH_TOKEN  # optional, only if you enabled auth
wrangler secret put SENTRY_DSN
wrangler secret put TEMPORAL_AUTH_TOKEN  # optional
```

Then set non-secret vars in `wrangler.toml` `[vars]` block:

```toml
TEMPORAL_ADDRESS = "https://temporal.example.com:8233"
TEMPORAL_NAMESPACE = "default"
TEMPORAL_TASK_QUEUE = "pukucloud-microvms"
```

Deploy:

```bash
wrangler deploy
```

## Verify

Open the Temporal UI. Trigger a workflow through the controller:

```bash
curl -X POST https://api.example.com/v1/sandboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"template":"base"}'
```

You should see:
- `workflow_id` in the response.
- The workflow appears in the Temporal UI as `Running`.
- Within ~30s, the workflow transitions to `Completed`.
- An Sentry transaction for `LaunchMicroVMWorkflow`.

## Production checklist

- [ ] External PostgreSQL for Temporal (the bundled one is for dev only).
- [ ] TLS + auth on Temporal frontend (`TEMPORAL_TLS=true`,
      `TEMPORAL_AUTH_ENABLED=true`).
- [ ] SMTP relay on Sentry for alert emails.
- [ ] Real `SENTRY_SECRET_KEY` (openssl rand).
- [ ] Backups for both Temporal and Sentry PostgreSQL instances.
- [ ] Metrics scraped from Temporal (`http://temporal:9090/metrics`).

## Teardown

```bash
cd infra/temporal && docker compose down -v
cd infra/sentry && docker compose down -v
```
# Self-hosted Sentry

PukuCloud reports errors and traces to Sentry. The Cloudflare Worker
controller, the Go agent, and the API server all initialize a Sentry SDK
on boot. DSN is read from the `SENTRY_DSN` environment variable on each
side.

## Bring up

```bash
cd infra/sentry
docker compose up -d
# open http://localhost:9000 and finish the bootstrap wizard
```

Generate a real secret key:

```bash
openssl rand -hex 32
# paste the result into SENTRY_SECRET_KEY in docker-compose.yml
```

Then create a project (Node for the CF Worker, Go for the agent and
API server) and copy the DSN. Set `SENTRY_DSN` on each component.

## What gets reported

| Source | Errors captured |
|--------|-----------------|
| CF Worker (controller) | All uncaught exceptions in routes, Temporal client errors, D1 errors, Sentry middleware catches API 500s |
| Go agent | Activity failures inside Temporal workflows, panic recovery, Firecracker errors with full stack |
| API server (if kept) | HTTP handler errors with request ID, DB query errors |

## Production checklist

- [ ] Real `SENTRY_SECRET_KEY` (openssl rand)
- [ ] External Postgres with backups
- [ ] SMTP relay configured (`SENTRY_EMAIL_HOST` etc.) so Sentry can send alert emails
- [ ] Project DSNs provisioned for each component and set in their env
- [ ] Source maps uploaded for the CF Worker (use `wrangler` Sentry plugin or manual upload)
- [ ] Retention / quota configured for your team

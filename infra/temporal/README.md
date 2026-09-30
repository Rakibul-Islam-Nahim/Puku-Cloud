# Self-hosted Temporal

PukuCloud uses Temporal for workflow orchestration. Workers (Go agents) poll a
task queue on this server, and the Cloudflare Worker controller starts /
signals / queries workflows here. There are no worker IPs or agent URLs
encoded in the controller — Temporal handles routing.

## Bring up

```bash
cd infra/temporal
docker compose up -d
```

Web UI (optional, on http://localhost:8080):

```bash
docker compose --profile ui up -d
```

Health check:

```bash
curl http://localhost:8233/health
```

## Connect from workers / clients

| Setting | Value |
|---------|-------|
| Frontend gRPC | `temporal.yourdomain.com:7233` (or `localhost:7233` for dev) |
| Namespace | `default` |
| TLS | Off by default — turn on with `TEMPORAL_TLS=true` env in `docker-compose.yml` and provision certs |
| Auth | Off by default — turn on with `TEMPORAL_AUTH_ENABLED=true` |

## Defaults

- Single namespace `default`. Add more via `tctl namespace register` if needed.
- Visibility TTL (history retention) is 7 days (`168h`). Bump `VISIBILITY_TTL`
  in `docker-compose.yml` for longer retention.
- Persistence is the bundled Postgres container. For production, point
  `POSTGRES_HOST` at an external Postgres you already manage.

## Production checklist

- [ ] External Postgres with backups
- [ ] TLS enabled (`TEMPORAL_TLS=true` + certs mounted into the container)
- [ ] Auth enabled (`TEMPORAL_AUTH_ENABLED=true` + mTLS or API keys)
- [ ] Fronted by a load balancer that does TLS termination
- [ ] Metrics scraped (Temporal exposes Prometheus on `:9090` if you start it)
- [ ] Alarms on Postgres lag, history service errors, and namespace backlog

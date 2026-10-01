// SPDX-License-Identifier: Apache-2.0
// Package main is the pukucloud agent: a small HTTP server that runs *inside*
// the Lima VM and drives Firecracker microVMs on behalf of the macOS-side API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/pukucloud/agent/internal/api"
	"github.com/pukucloud/agent/internal/config"
	"github.com/pukucloud/agent/internal/diskstream"
	"github.com/pukucloud/agent/internal/events"
	"github.com/pukucloud/agent/internal/guest"
	"github.com/pukucloud/agent/internal/nbdstream"
	"github.com/pukucloud/agent/internal/network"
	"github.com/pukucloud/agent/internal/obs"
	"github.com/pukucloud/agent/internal/sandbox"
	agentsentry "github.com/pukucloud/agent/internal/sentry"
	"github.com/pukucloud/agent/internal/slotstore"
	"github.com/pukucloud/agent/internal/store"
	agenttemporal "github.com/pukucloud/agent/internal/temporal"
	"github.com/pukucloud/agent/internal/temporal/activities"
)

func main() {
	// Subcommands run before flag parsing. `seed-sync` is a one-shot maintenance
	// command invoked by cloud-init at agent boot (before the service starts) to
	// pull fleet-shared template snapshots from GCS. It exits when done.
	if len(os.Args) > 1 && os.Args[1] == "seed-sync" {
		os.Exit(runSeedSync(os.Args[2:]))
	}

	var (
		socketPath    = flag.String("socket", "/run/pukucloud/agent.sock", "Unix socket to listen on")
		dataDir       = flag.String("data-dir", "/var/lib/pukucloud", "Root of templates / vms / snapshots")
		dbPath        = flag.String("db", "/var/lib/pukucloud-io/pukucloud-ai-oss.db", "SQLite metadata DB")
		slotDB        = flag.String("slot-db", "/var/lib/pukucloud-io/slots.db", "Local SQLite ledger owning /30 network slot indices. MUST be on the boot disk (slot state is ephemeral host state that resets on reboot), never the stateful data disk.")
		cidr          = flag.String("sandbox-cidr", "172.20.0.0/16", "CIDR pool for per-sandbox /30 subnets")
		idleAfter     = flag.Duration("idle-after", envDurationDefault("PUKUCLOUD_IDLE_AFTER", 0), "Auto-hibernate sandboxes idle for this long (0=disabled). Env override: PUKUCLOUD_IDLE_AFTER")
		metricsListen = flag.String("metrics-listen", os.Getenv("PUKUCLOUD_METRICS_LISTEN"), "Optional TCP listen address for /metrics + /healthz (e.g. :9100). Empty = serve on the unix socket only.")
		listenTCP     = flag.String("listen-tcp", os.Getenv("PUKUCLOUD_LISTEN_TCP"), "Optional TCP listen address for the full API (multi-node mode, X-Node-Token gated). Empty = unix socket only.")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	// Sentry init (no-op when SENTRY_DSN is unset). We initialize early
	// so any subsequent init failures are reported.
	if err := agentsentry.Init(
		strings.TrimSpace(os.Getenv("SENTRY_DSN")),
		strings.TrimSpace(os.Getenv("PUKUCLOUD_ENV")),
		api.Version().Semver,
	); err != nil {
		log.Warn("sentry init failed (continuing without error reporting)", "err", err)
	}

	cfg := config.Config{
		SocketPath: *socketPath,
		DataDir:    *dataDir,
		DBPath:     *dbPath,
		SlotDBPath: *slotDB,
		CIDR:       *cidr,
	}

	if err := run(cfg, *idleAfter, *metricsListen, *listenTCP, log); err != nil {
		log.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run(cfg config.Config, idleAfter time.Duration, metricsListen, listenTCP string, log *slog.Logger) error {
	if err := os.MkdirAll(filepath.Dir(cfg.SocketPath), 0o755); err != nil {
		return err
	}

	// Observability: OTel tracer + Prom registry. Both are safe to use
	// even if the OTLP endpoint is unset (no-op tracer).
	tracerShutdown, err := obs.InitTracer("pukucloud-agent", api.Version().Semver)
	if err != nil {
		log.Warn("otel init failed (continuing without tracing)", "err", err)
	} else if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" {
		log.Info("otel tracing enabled", "endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	}
	obs.RegisterCollectors()

	// Wire streaming-disk metric hooks to obs counters (§6.3). The diskstream /
	// nbdstream packages are dependency-free (no obs import) and expose no-op
	// hook vars; we bind them here so events are counted as they happen — so a
	// closed/recovered device's counts (esp. fetch_bytes) are never
	// lost. No-ops until bound, so unit tests of those packages stay isolated.
	diskstream.OnFetch = obs.DiskFetchesTotal.Inc
	diskstream.OnZeroFill = obs.DiskZeroFillTotal.Inc
	diskstream.OnFetchBytes = func(template, generation string, n int64) {
		obs.DiskFetchBytesTotal.WithLabelValues(template, generation).Add(float64(n))
	}
	diskstream.OnVerifyError = obs.DiskVerifyErrorsTotal.Inc
	diskstream.OnGCSRetry = obs.DiskGCSRetriesTotal.Inc
	diskstream.OnCapHit = obs.DiskCapHitsTotal.Inc
	nbdstream.OnBreakerOpen = obs.DiskBreakerOpenTotal.Inc

	st, err := store.Open(cfg.DBPath)
	if err != nil {
		return err
	}
	defer st.Close()

	// Local slot ledger (boot disk). Owns /30 slot indices authoritatively.
	if err := os.MkdirAll(filepath.Dir(cfg.SlotDBPath), 0o755); err != nil {
		return fmt.Errorf("mkdir slot db dir: %w", err)
	}
	slots, err := slotstore.Open(cfg.SlotDBPath)
	if err != nil {
		return err
	}
	defer slots.Close()

	netPool, err := network.NewPool(cfg.CIDR, st, slots)
	if err != nil {
		return err
	}

	keys, err := guest.NewKeyStore(cfg.DataDir)
	if err != nil {
		return err
	}
	log.Info("agent ssh key ready", "pub", keys.PublicPath)

	mgr := sandbox.NewManager(cfg, st, netPool, keys, events.NewBus(cfg.DataDir), log)
	defer mgr.Shutdown()
	if err := mgr.Recover(context.Background()); err != nil {
		log.Warn("recover incomplete", "err", err)
	}
	// Reconcile slot ownership against the sandboxes that actually survived
	// recovery. Frees slots stranded by a crash-mid-allocate (claimed before the
	// sandbox row existed) — which the sandbox-row-walking Recover() can't see —
	// while keeping the slots of recovered persistent VMs (managed DBs / apps).
	// On a cold boot (blank boot disk after autoheal) the ledger is empty and
	// this is a no-op; recovered persistent VMs re-derive their slots.
	if live, lerr := st.ListSandboxesForAgent(context.Background(), st.AgentID()); lerr == nil {
		ids := make([]string, 0, len(live))
		for _, sb := range live {
			if m, ok := sb.(map[string]any); ok {
				if id, _ := m["id"].(string); id != "" {
					ids = append(ids, id)
				}
			}
		}
		if n, rerr := netPool.Reconcile(context.Background(), ids); rerr != nil {
			log.Warn("slot reconcile failed", "err", rerr)
		} else if n > 0 {
			log.Info("reclaimed orphaned network slots on startup", "count", n)
		}
		// Orphan-loop sweep: detach loop devices whose backing file is gone or
		// whose backing vm dir belongs to a sandbox id not in the DB. A crash
		// that killed firecracker, let Recover GC the vm dir, but never detached
		// the cow.img loop device leaves a dangling loop that survives reboots
		// forever; this reclaims it on boot. Uses the SAME id set as the slot
		// Reconcile so a recovered persistent VM keeps its loop.
		if n := mgr.SweepOrphanLoops(ids); n > 0 {
			log.Info("reclaimed orphan loop devices on startup", "count", n)
		}
		// Orphan-netns sweep: delete every ns-* network namespace not backed by a
		// live sandbox. A crash/SIGKILL mid-teardown (a non-atomic kernel op —
		// KillMode=mixed rolling deploys / OOM) can strand a netns that keeps
		// answering ARP for its /30, poisoning a later create that reuses that
		// slot index (the static-builder-host deploy-loop incident). This runs
		// STRICTLY before StartNATIDPrewarmer below (empty free list, all prebuilt
		// sentinels freed by Reconcile), so it never races the prewarmer and any
		// surviving ns-p* is a dead prior-generation leftover. Fails closed if the
		// live keep-set can't be built (never risks a live persistent-VM netns).
		if n, err := netPool.SweepOrphanNetns(context.Background(), ids); err != nil {
			log.Warn("orphan netns sweep skipped", "err", err)
		} else if n > 0 {
			log.Info("reclaimed orphan network namespaces on startup", "count", n)
		}
	}
	// Start the NATID prewarmer ONLY after Recover()+Reconcile have run, so its
	// prebuilt slot sentinels can't be reclaimed mid-build by the one-shot
	// startup reconcile (which would cause a transient root-netns /30 collision).
	mgr.StartNATIDPrewarmer()

	// Audit-log retention. Default 365d (matches ClickHouse TTL); override via
	// PUKUCLOUD_AUDIT_RETENTION_DAYS=N (0 disables prune).
	{
		retainDays := 365
		if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_AUDIT_RETENTION_DAYS")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				retainDays = n
			}
		}
		if retainDays > 0 {
			retain := time.Duration(retainDays) * 24 * time.Hour
			go func() {
				// run once at startup, then hourly
				if n, err := st.PruneAudit(context.Background(), retain); err != nil {
					log.Warn("audit prune failed", "err", err)
				} else if n > 0 {
					log.Info("audit prune", "removed", n, "retain_days", retainDays)
				}
				t := time.NewTicker(time.Hour)
				defer t.Stop()
				for range t.C {
					if n, err := st.PruneAudit(context.Background(), retain); err != nil {
						log.Warn("audit prune failed", "err", err)
					} else if n > 0 {
						log.Info("audit prune", "removed", n, "retain_days", retainDays)
					}
				}
			}()
			log.Info("audit retention enabled", "days", retainDays)
		}
	}

	// ClickHouse analytics sink removed (Phase 4). Lifecycle events are still
	// recorded via the D1 audit_log on the controller side (see workers/src/
	// routes/sandboxes.ts and friends). chBoot/chEvent/chMetric on the
	// Manager are now no-op stubs so existing call sites compile cleanly.

	router := api.NewRouter(mgr, log)
	var handler http.Handler
	if jwksURL := strings.TrimSpace(os.Getenv("SUPABASE_JWKS_URL")); jwksURL != "" {
		audience := strings.TrimSpace(os.Getenv("SUPABASE_AUDIENCE"))
		if audience == "" {
			audience = "authenticated"
		}
		issuer := strings.TrimSpace(os.Getenv("SUPABASE_ISSUER"))
		if issuer == "" {
			issuer = deriveSupabaseIssuer(jwksURL)
		}
		skipPaths := defaultAuthSkipPaths()
		auth, err := api.NewAuth(api.AuthConfig{
			JWKSURL:   jwksURL,
			Issuer:    issuer,
			Audience:  audience,
			SkipPaths: skipPaths,
		})
		if err != nil {
			return fmt.Errorf("auth enabled but JWKS setup failed: %w", err)
		}
		handler = api.WithMiddlewareAuth(log, auth, router)
		log.Info("jwt auth enabled", "jwks_url", jwksURL, "issuer", issuer, "audience", audience, "skip_paths", skipPaths)
	} else {
		handler = api.WithMiddleware(log, router)
		log.Info("jwt auth disabled", "reason", "SUPABASE_JWKS_URL unset")
	}

	srv := &http.Server{
		Handler:     handler,
		ReadTimeout: 30 * time.Second,
		// No WriteTimeout: SSE streams (logs/events/exec) must outlive it.
	}

	_ = os.Remove(cfg.SocketPath)
	ln, err := net.Listen("unix", cfg.SocketPath)
	if err != nil {
		return err
	}
	_ = os.Chmod(cfg.SocketPath, 0o666)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Phase 3: idle sweeper (only if flag was set)
	if idleAfter > 0 {
		go mgr.RunIdleSweeper(ctx, idleAfter)
		log.Info("idle sweeper enabled", "after", idleAfter)
	}

	// Snapshot garbage collector. Snapshots are DURABLE — they outlive their
	// sandbox (cascade-delete fires only on an EXPLICIT user/feature delete, not
	// an idle-reap). This reaper reclaims orphaned snapshots (source sandbox
	// gone) only AFTER a grace period, giving a restore/fork window.
	//   PUKUCLOUD_SNAPSHOT_GC_INTERVAL  sweep cadence (Go duration; default 15m; "0" disables)
	//   PUKUCLOUD_SNAPSHOT_TTL_DAYS     grace days before an orphan expires (default 7; "0" = expire immediately)
	snapGCInterval := 15 * time.Minute
	if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_SNAPSHOT_GC_INTERVAL")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			snapGCInterval = d
		}
	}
	snapGrace := 7 * 24 * time.Hour
	if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_SNAPSHOT_TTL_DAYS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			snapGrace = time.Duration(n) * 24 * time.Hour
		}
	}
	if snapGCInterval > 0 {
		go mgr.RunSnapshotReaper(ctx, snapGCInterval, snapGrace)
		log.Info("snapshot reaper enabled", "interval", snapGCInterval.String(), "grace", snapGrace.String())
	}

	// Streaming-disk NBD watchdog (F5): force-recover a wedged NBD origin. Cheap
	// to run unconditionally (no-op without streaming bases), but only meaningful
	// when disk streaming is enabled.
	if os.Getenv("PUKUCLOUD_STREAM_DISK") == "1" {
		go mgr.RunDiskWatchdog(ctx)
		log.Info("streaming-disk watchdog enabled")
	}

	// Durable-volume auto-grow for managed databases (default on; set
	// PUKUCLOUD_VOLUME_AUTOGROW=0 to disable). Grows the PGDATA image when
	// the guest reports >=80% usage: host truncate → live PATCH /drives →
	// in-guest resize2fs.
	if os.Getenv("PUKUCLOUD_VOLUME_AUTOGROW") != "0" {
		go mgr.RunVolumeAutoGrow(ctx)
		log.Info("db volume auto-grow enabled")
	}

	// WAL archiving relay for managed databases (default on when the
	// snapshot bucket is configured; set PUKUCLOUD_WAL_ARCHIVE=0 to
	// disable). Guests POST WAL segments / base backups to the relay, which
	// spools them locally and replicates to GCS.
	if os.Getenv("PUKUCLOUD_WAL_ARCHIVE") != "0" {
		wr, err := sandbox.NewWALRelayFromEnv(mgr, log)
		switch {
		case err != nil:
			log.Warn("wal relay disabled", "err", err)
		case wr != nil:
			mgr.SetWALRelay(wr)
			go wr.Run(ctx)
			log.Info("wal archiving relay enabled", "addr", wr.Addr(), "bucket", wr.Bucket())
		default:
			log.Info("wal archiving relay disabled (no PUKUCLOUD_SNAPSHOT_BUCKET)")
		}
	}

	// DB health reconcile loop: probes running managed databases with
	// pg_isready, restarts postgres in place on failure, and marks the row
	// failed when restarts don't stick — the signal the failover preflight
	// accepts. Deliberately NOT gated on WAL archiving: a crashed postgres
	// deserves a restart on archiving-less (dev) deployments too.
	mgr.StartDBMonitor(ctx)

	// Managed-database auto-suspend: hibernate DBs idle past
	// PUKUCLOUD_DB_IDLE_AFTER_SECONDS (0/unset = disabled). Wake-on-connect
	// in db-proxy + the broker proxy resumes them transparently.
	mgr.StartDBIdleSweep(ctx)

	go func() {
		log.Info("agent listening", "socket", cfg.SocketPath)
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "err", err)
		}
	}()

	// Multi-node: TCP listener for inbound edge-→-agent traffic, plus
	// registry self-registration so the api scheduler can discover us.
	tcpSrv := startTCPListener(listenTCP, handler, log)
	reg := startRegistry(mgr, st, listenTCP, log)
	if reg != nil {
		// Wire lease-backed routing + zombie cleanup. Lease TTL > heartbeat
		// interval; periodic Acquire calls on activity will refresh it.
		agentID := strings.TrimSpace(os.Getenv("PUKUCLOUD_AGENT_ID"))
		if agentID == "" {
			h, _ := os.Hostname()
			agentID = h
		}
		leaseTTL := 24 * time.Hour
		if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_LEASE_TTL_SECONDS")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				leaseTTL = time.Duration(n) * time.Second
			}
		}
		mgr.SetLeaseSink(reg, agentID, leaseTTL)
		// One-shot: drop any leases this agent still owns from a prior
		// process incarnation. Without this, the dashboard would route
		// /v1/sandboxes/<id>/files to us for sandboxes our local store
		// has lost (zombie SSH timeouts on a destroyed guest IP).
		mgr.ReconcileLeasesOnStartup(ctx)
		// Periodic: clean leases whose owning agent died without releasing.
		sweepInterval := 5 * time.Minute
		if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_LEASE_SWEEP_SECONDS")); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				sweepInterval = time.Duration(n) * time.Second
			}
		}
		mgr.StartLeaseSweeper(ctx, sweepInterval)
	}

	// Optional TCP listener for /metrics + /healthz scraping by external
	// Prometheus (e.g. docker-compose stack). Mounts only safe endpoints.
	var metricsSrv *http.Server
	if metricsListen != "" {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", obs.MetricsHandler())
		mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		})
		metricsSrv = &http.Server{
			Addr:              metricsListen,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() {
			log.Info("metrics listening", "addr", metricsListen)
			if err := metricsSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("metrics server error", "err", err)
			}
		}()
	}

	// Temporal worker. Polls a task queue on the configured Temporal
	// server for activities (LaunchMicroVM, PauseMicroVM, etc.). The
	// controller starts workflows here; we just execute them. To add
	// capacity, just start more agents with the same TEMPORAL_ADDRESS.
	tcfg := agenttemporal.FromEnv()
	region := strings.TrimSpace(os.Getenv("PUKUCLOUD_REGION"))
	host, _ := os.Hostname()
	if tcfg.WorkerID == "worker" {
		tcfg.WorkerID = host
	}
	deps := activities.Deps{
		Manager:   mgr,
		WorkerID:  tcfg.WorkerID,
		Region:    region,
		SentryEnv: strings.TrimSpace(os.Getenv("PUKUCLOUD_ENV")),
	}
	go func() {
		// Wrap the worker's lifecycle in a context tied to the main
		// signal context so we shut down with the rest of the agent.
		if err := agenttemporal.Run(ctx, tcfg, deps); err != nil {
			log.Error("temporal worker stopped", "err", err)
			agentsentry.CaptureException(err, map[string]string{"component": "temporal_worker"})
		}
	}()
	log.Info("temporal worker registered",
		"address", tcfg.Address,
		"task_queue", tcfg.TaskQueue,
		"worker_id", tcfg.WorkerID,
		"region", region,
	)

	<-ctx.Done()
	log.Info("shutting down")
	// Sentry flush so any pending events get sent before exit.
	agentsentry.Flush(context.Background(), 5*time.Second)

	// Phase 1 always-on: graceful hibernate of persistent sandboxes BEFORE
	// we tear down HTTP/TCP listeners. Each sandbox's PauseAndSnapshot writes
	// vm.mem + vm.state under <vmDir>/hibernation/ so Recover() / EnsureRunning()
	// can wake them on the next agent boot. Use an independent context with
	// a hard budget — we'd rather lose hibernation on a few sandboxes than
	// leak the agent process past systemd's TimeoutStopSec.
	hiberBudget := 120 * time.Second
	if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_HIBERNATE_BUDGET_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			hiberBudget = time.Duration(n) * time.Second
		}
	}
	hiberCtx, hiberCancel := context.WithTimeout(context.Background(), hiberBudget)
	hiberPar := 4
	if v := strings.TrimSpace(os.Getenv("PUKUCLOUD_HIBERNATE_PARALLELISM")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			hiberPar = n
		}
	}
	ok, errs := mgr.HibernateAllPersistent(hiberCtx, hiberPar)
	hiberCancel()
	log.Info("graceful hibernate done", "hibernated", ok, "errors", len(errs), "budget", hiberBudget)

	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if metricsSrv != nil {
		_ = metricsSrv.Shutdown(shutCtx)
	}
	if tcpSrv != nil {
		_ = tcpSrv.Shutdown(shutCtx)
	}
	if tracerShutdown != nil {
		_ = tracerShutdown(shutCtx)
	}
	return srv.Shutdown(shutCtx)
}

func deriveSupabaseIssuer(jwksURL string) string {
	return strings.TrimSuffix(strings.TrimSuffix(jwksURL, "/.well-known/jwks.json"), "/")
}

func defaultAuthSkipPaths() []string {
	skip := []string{"/healthz", "/version", "/metrics", "/events", "/static/"}
	for _, p := range strings.Split(os.Getenv("PUKUCLOUD_AUTH_SKIP_PREFIXES"), ",") {
		p = strings.TrimSpace(p)
		if p != "" {
			skip = append(skip, p)
		}
	}
	return skip
}

// envDurationDefault returns the parsed time.Duration from the given env var,
// or the provided fallback if the var is unset or unparseable.
func envDurationDefault(name string, fallback time.Duration) time.Duration {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return fallback
	}
	return d
}

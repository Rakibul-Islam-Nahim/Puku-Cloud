// SPDX-License-Identifier: Apache-2.0
// Package temporal wires the agent to a Temporal server. Each bare-metal
// host runs one Temporal worker that polls a task queue for activities.
// Workers don't know about the controller (Cloudflare Worker) or any
// agent IPs — they only know the Temporal address. To add capacity, just
// start more workers on more hosts; Temporal load-balances.
package temporal

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"github.com/pukucloud/agent/internal/temporal/activities"
	"github.com/pukucloud/agent/internal/temporal/workflows"
)

// Config is what main() reads from environment variables.
type Config struct {
	// Address of the Temporal frontend (gRPC). E.g. "temporal:7233".
	Address string
	// Namespace the worker joins. Usually "default".
	Namespace string
	// TaskQueue the worker polls. Must match the queue the controller
	// uses when starting workflows.
	TaskQueue string
	// WorkerID identifies this bare-metal host in logs and Sentry tags.
	WorkerID string
	// MaxConcurrentActivities caps how many activities this worker
	// runs in parallel. Tune per host capacity (CPU, RAM).
	MaxConcurrentActivities int
}

// FromEnv builds a Config from environment variables with sensible defaults.
func FromEnv() Config {
	return Config{
		Address:                 envOr("TEMPORAL_ADDRESS", "localhost:7233"),
		Namespace:               envOr("TEMPORAL_NAMESPACE", "default"),
		TaskQueue:               envOr("TEMPORAL_TASK_QUEUE", "pukucloud-microvms"),
		WorkerID:                envOr("PUKUCLOUD_WORKER_ID", hostnameOr("worker")),
		MaxConcurrentActivities: 4, // conservative; bump per host
	}
}

// Run blocks until ctx is cancelled. It creates the Temporal client,
// registers all activities and workflows, and runs a worker. When the
// function returns, the worker has shut down cleanly.
func Run(ctx context.Context, cfg Config, deps activities.Deps) error {
	c, err := client.Dial(client.Options{
		HostPort:  cfg.Address,
		Namespace: cfg.Namespace,
		Identity:  cfg.WorkerID,
	})
	if err != nil {
		return fmt.Errorf("temporal dial: %w", err)
	}
	defer c.Close()

	w := worker.New(c, cfg.TaskQueue, worker.Options{
		Identity: cfg.WorkerID,
		// Heartbeat timeouts in workflows reference this.
		MaxConcurrentActivityExecutionSize: cfg.MaxConcurrentActivities,
		// Workflow-level concurrency is usually 1; we don't want one host
		// running 100 workflows at once.
		MaxConcurrentWorkflowTaskExecutionSize: 1,
		// Local activities are fast, run them inline.
		LocalActivityWorkerOnly: false,
	})

	// Workflows. Each workflow coordinates activities to do something
	// useful (launch, snapshot, delete). Workflows are crash-safe —
	// Temporal replays them from history.
	w.RegisterWorkflow(workflows.LaunchMicroVMWorkflow)
	w.RegisterWorkflow(workflows.CreateDatabaseWorkflow)
	w.RegisterWorkflow(workflows.PauseMicroVMWorkflow)
	w.RegisterWorkflow(workflows.ResumeMicroVMWorkflow)
	w.RegisterWorkflow(workflows.SnapshotMicroVMWorkflow)
	w.RegisterWorkflow(workflows.DeleteMicroVMWorkflow)

	// Activities. Activities are stateless functions that the workflow
	// calls. They do the actual work (Firecracker calls, vsock, etc.).
	// Deps (firecracker manager, store, worker_id, etc.) are passed via
	// the activity context at call time, not registration time.
	activities.RegisterAll(w, deps)

	log.Printf("temporal: worker starting (queue=%s, worker_id=%s, max_concurrent=%d)",
		cfg.TaskQueue, cfg.WorkerID, cfg.MaxConcurrentActivities)

	// Run blocks until the worker's context is cancelled.
	if err := w.Run(worker.InterruptCh()); err != nil {
		return fmt.Errorf("temporal worker: %w", err)
	}

	log.Printf("temporal: worker stopped")
	return nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func hostnameOr(fallback string) string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return fallback
	}
	return h
}

// StopTimeout is how long Run waits for the worker to drain in-flight
// activities before shutting down.
const StopTimeout = 30 * time.Second
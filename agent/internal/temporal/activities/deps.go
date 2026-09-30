// SPDX-License-Identifier: Apache-2.0
// Package activities implements the Temporal activities that the
// agent's workflows call. Activities are the "workers do this thing"
// functions. Each one calls into the existing Firecracker / sandbox
// / store code in this repo; Temporal handles retries, timeouts, and
// crash recovery around them.
package activities

import (
	"context"

	"go.temporal.io/sdk/activity"

	"github.com/pukucloud/agent/internal/sandbox"
	"github.com/pukucloud/agent/internal/sentry"
)

// Deps bundles the dependencies activities need. main() builds this once
// at boot (firecracker manager, store, etc.) and passes it to temporal.Run.
type Deps struct {
	Manager   *sandbox.Manager // existing Firecracker / sandbox manager
	WorkerID  string           // bare-metal hostname / agent id
	Region    string           // region tag, used in DO writes
	SentryEnv string           // "production", "staging", etc.
}

// GetDeps pulls Deps out of the activity context. Activities call this
// instead of touching globals. Returns nil if not registered (e.g. in tests).
func GetDeps(ctx context.Context) *Deps {
	if d, ok := ctx.Value(depsKey{}).(*Deps); ok {
		return d
	}
	return nil
}

// depsKey is the unexported context key for Deps.
type depsKey struct{}

// WithDeps returns a context that carries Deps. Activities retrieve them
// via GetDeps. This is registered with RegisterActivity so every activity
// gets the deps injected.
func WithDeps(d Deps) func(ctx context.Context) context.Context {
	return func(ctx context.Context) context.Context {
		return context.WithValue(ctx, depsKey{}, &d)
	}
}

// recordHeartbeat reports progress to Temporal and wraps any panic into
// an error so the workflow can decide whether to retry.
//
// Callers should call this periodically during long activities (every 30s
// for VM launches, every 10s for snapshotting).
func recordHeartbeat(ctx context.Context, progress int, detail string) {
	activity.RecordHeartbeat(ctx, map[string]interface{}{
		"progress": progress,
		"detail":   detail,
	})
}

// reportErr reports an activity error to Sentry with context tags. The
// activity itself returns the error to Temporal; Sentry just gets a copy.
func reportErr(ctx context.Context, err error, tags map[string]string) {
	if err == nil {
		return
	}
	deps := GetDeps(ctx)
	if tags == nil {
		tags = map[string]string{}
	}
	if deps != nil {
		tags["worker_id"] = deps.WorkerID
		tags["region"] = deps.Region
	}
	tags["activity"] = activity.GetInfo(ctx).ActivityType.Name
	sentry.CaptureException(err, tags)
}
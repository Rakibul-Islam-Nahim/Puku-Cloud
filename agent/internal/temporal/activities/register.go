// SPDX-License-Identifier: Apache-2.0

package activities

import (
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/worker"
)

// RegisterAll registers every activity with the Temporal worker. The
// activity function names below MUST match the names used in the
// workflow code (workflow.ExecuteActivity(ctx, "ActivityName", ...)).
//
// Adding a new activity: write the function in this package and add a
// Register call here.
func RegisterAll(w worker.Worker, deps Deps) {
	w.RegisterActivityWithOptions(LaunchMicroVM, activity.RegisterOptions{
		Name: "LaunchMicroVM",
	})
	w.RegisterActivityWithOptions(GetMicroVMStatus, activity.RegisterOptions{
		Name: "GetMicroVMStatus",
	})
	w.RegisterActivityWithOptions(PauseMicroVM, activity.RegisterOptions{
		Name: "PauseMicroVM",
	})
	w.RegisterActivityWithOptions(ResumeMicroVM, activity.RegisterOptions{
		Name: "ResumeMicroVM",
	})
	w.RegisterActivityWithOptions(SnapshotMicroVM, activity.RegisterOptions{
		Name: "SnapshotMicroVM",
	})
	w.RegisterActivityWithOptions(DeleteMicroVM, activity.RegisterOptions{
		Name: "DeleteMicroVM",
	})

	// Ensure deps isn't accidentally optimized out — it's used by
	// GetDeps at activity-call time, not registration time.
	_ = deps
}

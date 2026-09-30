// SPDX-License-Identifier: Apache-2.0

package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// PauseMicroVMWorkflow pauses a running microVM. Fast activity (sub-second).
func PauseMicroVMWorkflow(ctx workflow.Context, vmID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("PauseMicroVMWorkflow", "vm_id", vmID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: ShortActivityTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 1 * time.Second,
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	return workflow.ExecuteActivity(ctx, "PauseMicroVM", vmID).Get(ctx, nil)
}

// ResumeMicroVMWorkflow resumes a paused microVM.
func ResumeMicroVMWorkflow(ctx workflow.Context, vmID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("ResumeMicroVMWorkflow", "vm_id", vmID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: ShortActivityTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 1 * time.Second,
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	return workflow.ExecuteActivity(ctx, "ResumeMicroVM", vmID).Get(ctx, nil)
}

// SnapshotMicroVMWorkflow creates a memory snapshot for a running VM.
func SnapshotMicroVMWorkflow(ctx workflow.Context, vmID, snapshotName string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("SnapshotMicroVMWorkflow", "vm_id", vmID, "snapshot", snapshotName)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: SnapshotActivityTimeout,
		HeartbeatTimeout:    HeartbeatTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    1 * time.Minute,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	return workflow.ExecuteActivity(ctx, "SnapshotMicroVM", vmID, snapshotName).Get(ctx, nil)
}

// DeleteMicroVMWorkflow stops and cleans up a microVM.
func DeleteMicroVMWorkflow(ctx workflow.Context, vmID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("DeleteMicroVMWorkflow", "vm_id", vmID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: DeleteActivityTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 1 * time.Second,
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	return workflow.ExecuteActivity(ctx, "DeleteMicroVM", vmID).Get(ctx, nil)
}

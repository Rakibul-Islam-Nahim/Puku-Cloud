// SPDX-License-Identifier: Apache-2.0

package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// LaunchMicroVMWorkflow orchestrates the launch of a single Firecracker
// microVM. The controller (Cloudflare Worker) calls this workflow via
// Temporal client. Temporal routes the activity to an available bare-metal
// agent, retries on failure, and persists state across crashes.
//
// Sequence:
//  1. LaunchMicroVM activity → Firecracker InstanceStart
//  2. Wait for VM to become ready (heartbeat-driven)
//  3. Return VMResult with IP, VMID, worker_id
func LaunchMicroVMWorkflow(ctx workflow.Context, in LaunchMicroVMInput) (*LaunchMicroVMOutput, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("LaunchMicroVMWorkflow started", "workflow_id", in.WorkflowID)

	// Activity options: long timeout, heartbeat, retry policy.
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: LaunchActivityTimeout,
		HeartbeatTimeout:    HeartbeatTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    1 * time.Minute,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Execute the launch activity. Temporal handles retries.
	var result MicroVMResult
	if err := workflow.ExecuteActivity(ctx, "LaunchMicroVM", in.Spec).Get(ctx, &result); err != nil {
		logger.Error("LaunchMicroVM activity failed", "error", err)
		return nil, err
	}

	logger.Info("LaunchMicroVMWorkflow finished", "vm_id", result.VMID, "ip", result.IP)
	return &LaunchMicroVMOutput{
		VMID:      result.VMID,
		IP:        result.IP,
		State:     result.State,
		WorkerID:  result.WorkerID,
		StartedAt: result.StartedAt,
	}, nil
}

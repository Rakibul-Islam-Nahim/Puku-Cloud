// SPDX-License-Identifier: Apache-2.0

package workflows

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// CreateDatabaseInput is the input for creating a managed Postgres database
// (one microVM per database). Mirrors the request body for
// POST /v1/databases.
type CreateDatabaseInput struct {
	OrgID       string `json:"org_id"`
	Name        string `json:"name"`        // user-friendly name
	PostgresURL string `json:"postgres_url,omitempty"` // returned to caller
	Spec        MicroVMSpec `json:"spec"`
}

// CreateDatabaseResult is what the caller receives once the database is
// accepting connections.
type CreateDatabaseResult struct {
	DatabaseID  string `json:"database_id"`
	PostgresURL string `json:"postgres_url"`
	VMID        string `json:"vm_id"`
	WorkerID    string `json:"worker_id"`
}

// CreateDatabaseWorkflow launches a Postgres microVM and waits for it to
// accept connections. The result includes the postgres:// URL the caller
// can use from their application.
func CreateDatabaseWorkflow(ctx workflow.Context, in CreateDatabaseInput) (*CreateDatabaseResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("CreateDatabaseWorkflow", "name", in.Name)

	// Step 1: launch the database microVM.
	launchAO := workflow.ActivityOptions{
		StartToCloseTimeout: LaunchActivityTimeout,
		HeartbeatTimeout:    HeartbeatTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    1 * time.Minute,
			MaximumAttempts:    3,
		},
	}
	ctxLaunch := workflow.WithActivityOptions(ctx, launchAO)

	launchOut := &LaunchMicroVMOutput{}
	if err := workflow.ExecuteActivity(ctxLaunch, "LaunchMicroVM", in.Spec).Get(ctxLaunch, launchOut); err != nil {
		return nil, err
	}

	// Step 2: wait for Postgres to be ready. We poll a status activity
	// until state == "ready". In a fuller design this would be a child
	// workflow with a long-running "wait-for-ready" signal.
	shortAO := workflow.ActivityOptions{
		StartToCloseTimeout: ShortActivityTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 1 * time.Second,
			MaximumAttempts: 5,
		},
	}
	ctxStatus := workflow.WithActivityOptions(ctx, shortAO)

	// Poll for ready state with a hard timeout (5 minutes).
	deadline := workflow.Now(ctx).Add(5 * time.Minute)
	for workflow.Now(ctx).Before(deadline) {
		var status MicroVMResult
		if err := workflow.ExecuteActivity(ctxStatus, "GetMicroVMStatus", launchOut.VMID).Get(ctxStatus, &status); err != nil {
			logger.Warn("GetMicroVMStatus error, retrying", "error", err)
		} else if status.State == "ready" {
			logger.Info("CreateDatabaseWorkflow ready", "vm_id", launchOut.VMID)
			return &CreateDatabaseResult{
				DatabaseID:  in.Name, // map to your DB catalog id here
				PostgresURL: in.PostgresURL,
				VMID:        launchOut.VMID,
				WorkerID:    launchOut.WorkerID,
			}, nil
		}
		// Sleep before next poll. workflow.Sleep is durable.
		if err := workflow.Sleep(ctx, 5*time.Second); err != nil {
			return nil, err
		}
	}

	return nil, temporal.NewApplicationError("database not ready within timeout", "DatabaseNotReadyError")
}

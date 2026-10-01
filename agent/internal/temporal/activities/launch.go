// SPDX-License-Identifier: Apache-2.0

package activities

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"

	"github.com/pukucloud/agent/internal/sandbox"
	"github.com/pukucloud/agent/internal/sentry"
	"github.com/pukucloud/agent/internal/temporal/workflows"
)

// LaunchMicroVM is the Temporal activity that launches a Firecracker
// microVM. The existing sandbox.Manager.Create in this repo handles the
// heavy lifting (snapshot restore, UFFD, NBD, vsock, networking). This
// wrapper translates a Temporal workflow input into a sandbox.CreateRequest,
// drives heartbeats during the long-running call, and reports the
// final VMID/IP back to the workflow.
//
// Heartbeats are sent at most every 10s during the launch so Temporal
// knows the activity is alive even on a multi-minute snapshot restore.
func LaunchMicroVM(ctx context.Context, spec workflows.MicroVMSpec) (*workflows.MicroVMResult, error) {
	logger := activity.GetLogger(ctx)
	deps := GetDeps(ctx)
	if deps == nil || deps.Manager == nil {
		return nil, fmt.Errorf("activity deps missing (agent not initialized)")
	}

	logger.Info("LaunchMicroVM starting", "template", spec.Template, "org", spec.OrgID)

	start := time.Now().UTC()
	recordHeartbeat(ctx, 0, "starting")

	// Translate MicroVMSpec into the existing sandbox.CreateRequest shape.
	ttl := 0
	if spec.TTLSeconds > 0 {
		ttl = spec.TTLSeconds
	}
	req := sandbox.CreateRequest{
		Template:   spec.Template,
		CPU:        spec.VCPUCount,
		MemoryMB:   spec.MemMiB,
		DiskGB:     spec.DiskGiB,
		Metadata: map[string]string{
			"org_id":       spec.OrgID,
			"requested_by": spec.RequestedBy,
			"region":       spec.Region,
		},
		TTLSeconds: &ttl,
	}

	// Periodic heartbeat goroutine. Manager.Create can take minutes for
	// cold snapshot restores; without a heartbeat Temporal will mark the
	// activity as timed out (HeartbeatTimeout is set in the workflow).
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		progress := 10
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if progress < 90 {
					progress += 10
				}
				recordHeartbeat(ctx, progress, "launching")
			}
		}
	}()

	// Mirror the heartbeat to the controller's per-worker Durable Object
	// so the dashboard can show live agent state. Best-effort: failures
	// here don't fail the launch.
	stopCtrlHB := StartHeartbeat(ctx, deps, "launching", "")
	defer stopCtrlHB()

	vm, err := deps.Manager.Create(ctx, req)
	if err != nil {
		reportErr(ctx, err, map[string]string{"phase": "create"})
		return nil, fmt.Errorf("create microvm: %w", err)
	}

	// Final heartbeat at 100% before returning.
	recordHeartbeat(ctx, 100, "ready")

	result := &workflows.MicroVMResult{
		VMID:       vm.ID,
		IP:         vm.GuestIP,
		State:      string(vm.Status),
		WorkerID:   deps.WorkerID,
		StartedAt:  start,
		FinishedAt: time.Now().UTC(),
		Duration:   time.Since(start).String(),
	}

	logger.Info("LaunchMicroVM done", "vm_id", vm.ID, "ip", vm.GuestIP)
	return result, nil
}

// GetMicroVMStatus queries the in-memory sandbox manager for a VM's
// current state. Used by CreateDatabaseWorkflow to wait for readiness.
func GetMicroVMStatus(ctx context.Context, vmID string) (*workflows.MicroVMResult, error) {
	deps := GetDeps(ctx)
	if deps == nil || deps.Manager == nil {
		return nil, fmt.Errorf("activity deps missing")
	}
	row, err := deps.Manager.Get(ctx, vmID)
	if err != nil {
		return nil, fmt.Errorf("get microvm %s: %w", vmID, err)
	}
	// Get returns map[string]any. Extract state for the workflow.
	state := ""
	if rmap, ok := row.(map[string]any); ok {
		if s, ok := rmap["status"].(string); ok {
			state = s
		}
	}
	return &workflows.MicroVMResult{
		VMID:     vmID,
		State:    state,
		WorkerID: deps.WorkerID,
	}, nil
}

// PauseMicroVM pauses a running microVM.
func PauseMicroVM(ctx context.Context, vmID string) error {
	deps := GetDeps(ctx)
	if deps == nil || deps.Manager == nil {
		return fmt.Errorf("activity deps missing")
	}
	if err := deps.Manager.Pause(ctx, vmID); err != nil {
		reportErr(ctx, err, map[string]string{"vm_id": vmID, "op": "pause"})
		return err
	}
	return nil
}

// ResumeMicroVM resumes a paused microVM.
func ResumeMicroVM(ctx context.Context, vmID string) error {
	deps := GetDeps(ctx)
	if deps == nil || deps.Manager == nil {
		return fmt.Errorf("activity deps missing")
	}
	if err := deps.Manager.Resume(ctx, vmID); err != nil {
		reportErr(ctx, err, map[string]string{"vm_id": vmID, "op": "resume"})
		return err
	}
	return nil
}

// SnapshotMicroVM creates a memory snapshot for a running microVM.
// Reports progress via heartbeats since snapshotting can take minutes.
func SnapshotMicroVM(ctx context.Context, vmID, snapshotName string) error {
	deps := GetDeps(ctx)
	if deps == nil || deps.Manager == nil {
		return fmt.Errorf("activity deps missing")
	}
	recordHeartbeat(ctx, 0, "snapshot start")
	stopCtrlHB := StartHeartbeat(ctx, deps, "snapshotting", vmID)
	defer stopCtrlHB()

	// Snapshotting can take minutes for large memory. Heartbeat every 10s.
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		progress := 10
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if progress < 90 {
					progress += 10
				}
				recordHeartbeat(ctx, progress, "snapshotting")
			}
		}
	}()

	if _, err := deps.Manager.Snapshot(ctx, vmID); err != nil {
		reportErr(ctx, err, map[string]string{"vm_id": vmID, "op": "snapshot"})
		return err
	}
	recordHeartbeat(ctx, 100, "snapshot done")
	return nil
}

// DeleteMicroVM stops and cleans up a microVM.
func DeleteMicroVM(ctx context.Context, vmID string) error {
	deps := GetDeps(ctx)
	if deps == nil || deps.Manager == nil {
		return fmt.Errorf("activity deps missing")
	}
	if err := deps.Manager.Delete(ctx, vmID); err != nil {
		reportErr(ctx, err, map[string]string{"vm_id": vmID, "op": "delete"})
		return err
	}
	// Suppress unused-import warning if sentry gains new helpers.
	_ = sentry.CaptureException
	return nil
}
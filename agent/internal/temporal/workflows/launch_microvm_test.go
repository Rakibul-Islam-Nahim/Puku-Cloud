// SPDX-License-Identifier: Apache-2.0
package workflows

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

// TestLaunchMicroVMWorkflow_HappyPath drives the workflow with a mocked
// LaunchMicroVM activity that returns a successful result, and asserts the
// workflow returns a populated LaunchMicroVMOutput.
func TestLaunchMicroVMWorkflow_HappyPath(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestWorkflowEnvironment()

	// Register a stand-in activity with the same name the workflow uses.
	env.RegisterActivityWithOptions(
		func(_ any) (*MicroVMResult, error) {
			return &MicroVMResult{
				VMID:      "vm-1",
				IP:        "172.20.0.10",
				State:     "running",
				WorkerID:  "agent-1",
				StartedAt: time.Now().UTC(),
			}, nil
		},
		activity.RegisterOptions{Name: "LaunchMicroVM"},
	)

	in := LaunchMicroVMInput{
		WorkflowID: "wf-test",
		Spec: MicroVMSpec{
			Template:    "debian-12",
			VCPUCount:   1,
			MemMiB:      512,
			DiskGiB:     10,
			OrgID:       "org-test",
			RequestedBy: "user-test",
			Region:      "us-central1-a",
		},
	}

	env.ExecuteWorkflow(LaunchMicroVMWorkflow, in)
	require.True(t, env.IsWorkflowCompleted())

	var out LaunchMicroVMOutput
	require.NoError(t, env.GetWorkflowResult(&out))
	require.Equal(t, "vm-1", out.VMID)
	require.Equal(t, "172.20.0.10", out.IP)
	require.Equal(t, "running", out.State)
	require.Equal(t, "agent-1", out.WorkerID)
}

// TestLaunchMicroVMWorkflow_ActivityError drives the workflow with an
// activity that returns an error and verifies the workflow propagates it.
func TestLaunchMicroVMWorkflow_ActivityError(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(
		func(_ any) (*MicroVMResult, error) {
			return nil, &testError{msg: "boom"}
		},
		activity.RegisterOptions{Name: "LaunchMicroVM"},
	)

	in := LaunchMicroVMInput{
		WorkflowID: "wf-test",
		Spec:       MicroVMSpec{Template: "debian-12", VCPUCount: 1, MemMiB: 512, DiskGiB: 10},
	}

	env.ExecuteWorkflow(LaunchMicroVMWorkflow, in)
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
}

// testError is a tiny error type so we don't need testify in the import.
type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }
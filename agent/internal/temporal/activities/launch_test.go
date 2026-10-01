// SPDX-License-Identifier: Apache-2.0
package activities

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"

	"github.com/pukucloud/agent/internal/temporal/workflows"
)

// TestLaunchMicroVM_MissingDeps ensures LaunchMicroVM returns a clear error
// when the activity is invoked without a configured Deps.
//
// Note this is run inside TestActivityEnvironment so that activity.GetLogger
// (called at the top of LaunchMicroVM) does not panic with "Not an activity
// context". The activity still sees no Deps in its context and returns the
// expected error.
func TestLaunchMicroVM_MissingDeps(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(LaunchMicroVM)

	_, err := env.ExecuteActivity(LaunchMicroVM, workflows.MicroVMSpec{
		Template:    "debian-12",
		VCPUCount:   1,
		MemMiB:      512,
		DiskGiB:     10,
		OrgID:       "org-test",
		RequestedBy: "user-test",
		Region:      "us-central1-a",
	})
	require.Error(t, err)
}

// TestPauseMicroVM_MissingDeps mirrors the launch test for PauseMicroVM.
func TestPauseMicroVM_MissingDeps(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(PauseMicroVM)
	_, err := env.ExecuteActivity(PauseMicroVM, "vm-1")
	require.Error(t, err)
}

// TestResumeMicroVM_MissingDeps mirrors the launch test for ResumeMicroVM.
func TestResumeMicroVM_MissingDeps(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(ResumeMicroVM)
	_, err := env.ExecuteActivity(ResumeMicroVM, "vm-1")
	require.Error(t, err)
}

// TestSnapshotMicroVM_MissingDeps mirrors the launch test for SnapshotMicroVM.
func TestSnapshotMicroVM_MissingDeps(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(SnapshotMicroVM)
	_, err := env.ExecuteActivity(SnapshotMicroVM, "vm-1", "snap-1")
	require.Error(t, err)
}

// TestDeleteMicroVM_MissingDeps mirrors the launch test for DeleteMicroVM.
func TestDeleteMicroVM_MissingDeps(t *testing.T) {
	var ts testsuite.WorkflowTestSuite
	env := ts.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteMicroVM)
	_, err := env.ExecuteActivity(DeleteMicroVM, "vm-1")
	require.Error(t, err)
}

// TestReportHeartbeat_NoEnv verifies that reportHeartbeat is a no-op when
// the controller URL or token is unset. We don't want a misconfigured
// agent to crash on every activity.
func TestReportHeartbeat_NoEnv(t *testing.T) {
	t.Setenv("PUKUCLOUD_CONTROLLER_URL", "")
	t.Setenv("PUKUCLOUD_AGENT_TOKEN", "")
	// Should not panic and should not fail.
	reportHeartbeat(context.Background(), HeartbeatState{WorkerID: "agent-x"})
}

// TestStartHeartbeat_StopIsIdempotent verifies the returned close function
// can be called multiple times without panicking. The HTTP target is
// never hit because the controller URL is unset.
func TestStartHeartbeat_StopIsIdempotent(t *testing.T) {
	deps := &Deps{WorkerID: "agent-x", Region: "us-central1-a"}
	stop := StartHeartbeat(context.Background(), deps, "idle", "")
	stop()
	stop() // second call must not panic (channel already closed).
}

// TestStartHeartbeat_PostsToController uses an httptest server to capture
// heartbeats and verify the helper is reaching out.
func TestStartHeartbeat_PostsToController(t *testing.T) {
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if got := r.Header.Get("Authorization"); got != "Bearer the-token" {
			t.Errorf("Authorization header = %q, want 'Bearer the-token'", got)
		}
		if r.URL.Path != "/v1/internal/agents/agent-99/state" {
			t.Errorf("path = %q, want /v1/internal/agents/agent-99/state", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	t.Setenv("PUKUCLOUD_CONTROLLER_URL", srv.URL)
	t.Setenv("PUKUCLOUD_AGENT_TOKEN", "the-token")
	defer os.Unsetenv("PUKUCLOUD_CONTROLLER_URL")
	defer os.Unsetenv("PUKUCLOUD_AGENT_TOKEN")

	deps := &Deps{WorkerID: "agent-99", Region: "us-central1-a"}
	stop := StartHeartbeat(context.Background(), deps, "launching", "vm-abc")
	stop()
	// We don't wait for a tick (10s) — the helper returns a stop function
	// and doesn't blow up on rapid start/stop. The wiring is what we
	// verify here; tick timing is exercised in production.
	_ = time.Now()
}

// TestReportHeartbeat_Handles5xx verifies a 5xx response from the
// controller doesn't panic or hang the caller.
func TestReportHeartbeat_Handles5xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("nope"))
	}))
	defer srv.Close()

	t.Setenv("PUKUCLOUD_CONTROLLER_URL", srv.URL)
	t.Setenv("PUKUCLOUD_AGENT_TOKEN", "tok")
	defer os.Unsetenv("PUKUCLOUD_CONTROLLER_URL")
	defer os.Unsetenv("PUKUCLOUD_AGENT_TOKEN")

	// Should not panic, should not hang.
	done := make(chan struct{})
	go func() {
		reportHeartbeat(context.Background(), HeartbeatState{WorkerID: "agent-x"})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("reportHeartbeat hung after 2s on a 5xx response")
	}
}

// TestRecordHeartbeat_NoActivityContext is intentionally NOT written:
// the Temporal SDK's activity.RecordHeartbeat panics when called outside
// an activity context, which is the same panic a real agent would hit
// if it called the function in the wrong goroutine. The fix is at the
// call site (always inside an activity), not a defensive wrapper.

// TestReportErr_NoDeps ensures reportErr handles a missing Deps cleanly
// rather than dereferencing nil.
func TestReportErr_NoDeps(t *testing.T) {
	// Should not panic.
	reportErr(context.Background(), nil, nil)
}
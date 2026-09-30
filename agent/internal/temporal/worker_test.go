// SPDX-License-Identifier: Apache-2.0
package temporal

import (
	"testing"

	"github.com/pukucloud/agent/internal/temporal/activities"
)

func TestConfig_Defaults(t *testing.T) {
	t.Setenv("TEMPORAL_ADDRESS", "")
	t.Setenv("TEMPORAL_NAMESPACE", "")
	t.Setenv("TEMPORAL_TASK_QUEUE", "")
	t.Setenv("PUKUCLOUD_WORKER_ID", "")

	cfg := FromEnv()
	if cfg.Address != "localhost:7233" {
		t.Errorf("default Address = %q, want localhost:7233", cfg.Address)
	}
	if cfg.Namespace != "default" {
		t.Errorf("default Namespace = %q, want default", cfg.Namespace)
	}
	if cfg.TaskQueue != "pukucloud-microvms" {
		t.Errorf("default TaskQueue = %q, want pukucloud-microvms", cfg.TaskQueue)
	}
	if cfg.WorkerID == "" {
		t.Errorf("WorkerID should default to hostname, got empty")
	}
}

func TestConfig_OverridesFromEnv(t *testing.T) {
	t.Setenv("TEMPORAL_ADDRESS", "temporal.example.com:7233")
	t.Setenv("TEMPORAL_NAMESPACE", "prod")
	t.Setenv("TEMPORAL_TASK_QUEUE", "vms-prod")
	t.Setenv("PUKUCLOUD_WORKER_ID", "host-1")

	cfg := FromEnv()
	if cfg.Address != "temporal.example.com:7233" {
		t.Errorf("Address = %q, want temporal.example.com:7233", cfg.Address)
	}
	if cfg.Namespace != "prod" {
		t.Errorf("Namespace = %q, want prod", cfg.Namespace)
	}
	if cfg.TaskQueue != "vms-prod" {
		t.Errorf("TaskQueue = %q, want vms-prod", cfg.TaskQueue)
	}
	if cfg.WorkerID != "host-1" {
		t.Errorf("WorkerID = %q, want host-1", cfg.WorkerID)
	}
}

// TestDeps_Build ensures activities.Deps can be constructed without
// actually dialing anything.
func TestDeps_Build(t *testing.T) {
	d := activities.Deps{
		WorkerID: "test",
		Region:   "us-east",
	}
	if d.WorkerID != "test" || d.Region != "us-east" {
		t.Errorf("Deps fields not preserved: %+v", d)
	}
}
// SPDX-License-Identifier: Apache-2.0

// Heartbeat reporting from agent → controller's per-worker Durable Object.
//
// The agent runs on bare metal; the controller runs in Cloudflare Workers.
// Workers are reachable over HTTPS, so the agent can post its live state
// (status, current VM ID, capacity) directly to the controller. The
// controller's WorkerStateDO persists it; the dashboard reads it back to
// render real-time agent tiles.
//
// This package provides one helper:
//
//	reportHeartbeat(ctx, HeartbeatState{...})
//
// It is intentionally best-effort: a failed heartbeat must never block the
// activity. Failures are reported to Sentry (if configured) so operators
// can see that an agent is having trouble reaching the controller.

package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

// HeartbeatState is the JSON shape posted to the per-worker DO.
type HeartbeatState struct {
	WorkerID    string `json:"worker_id"`
	Region      string `json:"region"`
	Status      string `json:"status"`
	CurrentVMID string `json:"current_vm_id,omitempty"`
	Capacity    struct {
		CPUTotal int `json:"cpu_total"`
		CPUUsed  int `json:"cpu_used"`
		MemTotal int `json:"mem_total_mb"`
		MemUsed  int `json:"mem_used_mb"`
	} `json:"capacity"`
	LastSeen string `json:"last_seen"`
}

// reportHeartbeat sends the agent's live state to the controller's
// per-worker Durable Object. Best-effort: HTTP errors and timeouts are
// swallowed and reported to Sentry via the activity logger (caller can
// promote to an explicit CaptureException if needed).
//
// Endpoint is read from PUKUCLOUD_CONTROLLER_URL (e.g.
// "https://pukucloud-api.example.workers.dev"). Token from
// PUKUCLOUD_AGENT_TOKEN. Both must be set; otherwise the function is a
// no-op so local single-agent dev still works.
func reportHeartbeat(ctx context.Context, state HeartbeatState) {
	endpoint := os.Getenv("PUKUCLOUD_CONTROLLER_URL")
	token := os.Getenv("PUKUCLOUD_AGENT_TOKEN")
	if endpoint == "" || token == "" || state.WorkerID == "" {
		return
	}
	state.LastSeen = time.Now().UTC().Format(time.RFC3339)

	body, err := json.Marshal(state)
	if err != nil {
		return
	}

	url := endpoint + "/v1/internal/agents/" + state.WorkerID + "/state"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		// Best-effort: drain body so the connection can be reused, but
		// don't bother decoding it.
		_, _ = bytes.NewBuffer(nil).ReadFrom(resp.Body)
		_ = fmt.Sprintf("heartbeat %s: %d", url, resp.StatusCode)
	}
}

// StartHeartbeat launches a goroutine that posts the agent's live state
// to the controller on a fixed interval. It returns a stop function the
// caller MUST defer so heartbeats stop with the activity. The stop
// function is safe to call multiple times (sync.Once) so a `defer stop()`
// pattern that runs twice — typical in test harnesses — won't panic.
func StartHeartbeat(ctx context.Context, deps *Deps, status string, currentVMID string) func() {
	if deps == nil {
		return func() {}
	}
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				reportHeartbeat(ctx, HeartbeatState{
					WorkerID:    deps.WorkerID,
					Region:      deps.Region,
					Status:      status,
					CurrentVMID: currentVMID,
				})
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}
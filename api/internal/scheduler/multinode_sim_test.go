// SPDX-License-Identifier: Apache-2.0
package scheduler

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestMultiNodeSimulationBurst drives Pick() against an in-memory agent list
// using the same scoring path the live scheduler uses, with three identical
// "fresh" agents and 20 concurrent sized creates.
//
// Bypasses the DB-time-freshness filter (which is Postgres-specific) by
// pre-populating the cache directly — this isolates the burst-spread logic
// from the DB dialect shim.
func TestMultiNodeSimulationBurst(t *testing.T) {
	now := time.Now()
	mkAgent := func(id string) Agent {
		return Agent{
			ID: id, Endpoint: "http://" + id + ":9090", Region: "us-central1", Zone: "a",
			Version: "v1", Status: "active",
			Capacity:    Capacity{CPUTotal: 8, CPUUsed: 0, MemoryMB: 16384, MemoryUsed: 0, Sandboxes: 0, LoadAverage: 0.1},
			LastHeartbeat: now,
		}
	}
	agents := []Agent{
		// 32 GiB per agent so each can absorb the 8GiB ask twice without
		// spuriously failing — keeps the test focused on burst-spread, not
		// the admission gate.
		mkAgent("agent-1"), mkAgent("agent-2"), mkAgent("agent-3"),
	}
	for i := range agents {
		agents[i].Capacity.MemoryMB = 32768
	}

	s := New(nil, time.Hour) // long TTL so cache wins over List's nil-DB call
	s.mu.Lock()
	s.cache = agents
	s.cachedAt = now
	s.mu.Unlock()

	const creates = 20
	var counts sync.Map
	var wg sync.WaitGroup
	var failures int64
	for i := 0; i < creates; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := s.Pick(context.Background(), Request{CPU: 4, MemoryMB: 2048})
			if err != nil { atomic.AddInt64(&failures, 1); return }
			v, _ := counts.LoadOrStore(a.ID, new(int64))
			atomic.AddInt64(v.(*int64), 1)
		}()
	}
	wg.Wait()

	used := 0
	counts.Range(func(k, v any) bool {
		n := atomic.LoadInt64(v.(*int64))
		t.Logf("  %s: %d placements", k, n)
		used++
		return true
	})
	if failures > 0 { t.Fatalf("%d/%d creates failed", failures, creates) }
	if used < len(agents) {
		t.Fatalf("expected spread across %d agents, only %d received placements", len(agents), used)
	}
	t.Logf("OK: %d concurrent creates spread across all %d nodes", creates, used)
}

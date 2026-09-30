// SPDX-License-Identifier: Apache-2.0
package sentry

import (
	"errors"
	"testing"
)

func TestInit_NoDSN_NoOp(t *testing.T) {
	// Empty DSN should not error and should leave the SDK disabled.
	if err := Init("", "test", "v0.0.0"); err != nil {
		t.Fatalf("Init with empty DSN should succeed (no-op), got: %v", err)
	}
}

func TestCaptureException_NoDSN_NoPanic(t *testing.T) {
	// With DSN unset, CaptureException must not panic.
	CaptureException(errors.New("test"), nil)
	CaptureException(errors.New("test"), map[string]string{"tag": "value"})
}

func TestFlush_NoDSN_NoPanic(t *testing.T) {
	// Flush with uninitialized SDK must not panic.
	Flush(nil, 1)
}
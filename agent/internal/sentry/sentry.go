// SPDX-License-Identifier: Apache-2.0
// Package sentry initializes the Sentry SDK for the agent.
//
// All uncaught panics inside Temporal activities, HTTP handlers, and
// goroutines should be reported via sentry.CaptureException. The SDK is
// no-op when SENTRY_DSN is empty, so this package is safe to import in
// tests and dev builds without configuration.
package sentry

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/getsentry/sentry-go"
)

// Init configures the global Sentry client. Call once from main() before
// the Temporal worker starts. If dsn is empty, this is a no-op.
//
// environment is "production", "staging", etc.
// release is a git SHA or version tag.
func Init(dsn, environment, release string) error {
	if dsn == "" {
		log.Printf("sentry: DSN not set, error reporting disabled")
		return nil
	}

	err := sentry.Init(sentry.ClientOptions{
		Dsn:              dsn,
		Environment:      environment,
		Release:          release,
		AttachStacktrace: true,
		TracesSampleRate: 0.1, // 10% of transactions; tune per traffic
		// ServerName picks up the host's hostname so error reports are
		// grouped per bare-metal agent.
		ServerName: hostnameOr("unknown"),
		BeforeSend: func(event *sentry.Event, hint *sentry.EventHint) *sentry.Event {
			// Strip secrets from breadcrumbs / extra context here.
			return event
		},
	})
	if err != nil {
		return fmt.Errorf("sentry init: %w", err)
	}

	log.Printf("sentry: initialized (env=%s, release=%s)", environment, release)
	return nil
}

// Flush blocks until pending events are sent or the timeout elapses.
// Call this from main() right before os.Exit so errors aren't lost.
func Flush(ctx context.Context, timeout time.Duration) {
	sentry.Flush(timeout)
	_ = ctx
}

// CaptureException reports an error to Sentry. Tags are added to the
// event so reports can be filtered per worker / region / activity.
func CaptureException(err error, tags map[string]string) {
	if err == nil {
		return
	}
	if tags == nil {
		sentry.CaptureException(err)
		return
	}
	sentry.WithScope(func(scope *sentry.Scope) {
		for k, v := range tags {
			scope.SetTag(k, v)
		}
		sentry.CaptureException(err)
	})
}

// hostnameOr returns the hostname from the OS, or fallback if lookup fails.
func hostnameOr(fallback string) string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return fallback
	}
	return h
}

// SPDX-License-Identifier: Apache-2.0
"use client";

import { Card, PageHeader } from "@/components/ui";

/**
 * Observability dashboard.
 *
 * Phase 4: ClickHouse was removed. Time-series analytics are not yet
 * re-introduced (the plan defers analytics to a follow-up). The page
 * remains navigable so dashboard routing doesn't break — it shows a
 * one-line notice pointing operators at the audit log + worker live
 * state for current visibility.
 */
export default function ObservabilityPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Observability"
        description="Time-series analytics are temporarily disabled while we finish the control-plane migration."
      />
      <Card>
        <div className="px-4 py-6 space-y-3 text-sm text-[var(--text-muted)]">
          <p>
            The previous ClickHouse-backed time-series charts have been retired
            with the move to Temporal + D1 + Durable Objects.
          </p>
          <p>
            State-changing actions still appear in the{" "}
            <a className="text-[var(--text-primary)]" href="/audit">
              audit log
            </a>
            . For per-agent live state, see the{" "}
            <a className="text-[var(--text-primary)]" href="/workers">
              workers
            </a>{" "}
            page.
          </p>
          <p>
            Re-introducing a metrics backend is tracked for a follow-up
            release.
          </p>
        </div>
      </Card>
    </div>
  );
}

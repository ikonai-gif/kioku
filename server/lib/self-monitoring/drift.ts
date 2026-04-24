/**
 * KIOKU™ Self-Monitoring — Drift Detection
 *
 * Pure diff logic. Takes a baseline and the latest truth snapshot,
 * returns structured drift events. No DB writes, no HTTP, no side effects.
 *
 * Design decision (per design doc #5): severity-based acknowledgement.
 *   - env_flag_changed: info, auto-acknowledged during baseline upsert
 *   - tool_added / tool_removed: critical, MUST be manually acknowledged
 *     via POST /api/admin/self-monitoring/baseline/accept
 *   - tool_went_silent: warn, tracked but does not block baseline
 */

import type { EnvFlags, CapabilitiesTruth } from "./collect";

// ── Types ────────────────────────────────────────────────────────────────────

export type DriftChangeType =
  | "env_flag_changed"
  | "tool_added"
  | "tool_removed"
  | "tool_went_silent";

export type DriftSeverity = "info" | "warn" | "critical";

export type DriftEvent = {
  severity: DriftSeverity;
  changeType: DriftChangeType;
  detail: string;
  beforeValue: unknown;
  afterValue: unknown;
};

export type BaselineShape = {
  envFlags: EnvFlags;
  tools: Array<{ tool: string; category: "v1a" | "base"; in_schema: true }>;
};

// ── Severity table ───────────────────────────────────────────────────────────

const SEVERITY: Record<DriftChangeType, DriftSeverity> = {
  env_flag_changed: "info",
  tool_added: "critical",
  tool_removed: "critical",
  tool_went_silent: "warn",
};

// ── Core diff ────────────────────────────────────────────────────────────────

/**
 * Compare a stored baseline against a fresh truth snapshot, emit drift events.
 *
 * Detected classes:
 *   1. Any env flag whose effective value changed.
 *   2. Any tool that is in truth but not in baseline (tool_added).
 *   3. Any tool in baseline but not in truth (tool_removed).
 *   4. Any tool that WAS observed firing in the previous window but isn't
 *      firing now (tool_went_silent). A tool that has never been observed
 *      is NOT flagged — only a regression from observed→silent is worth alerting.
 *
 * Returns events in a stable order: env flags first (alphabetical), then
 * added tools, removed, silent — each alphabetical by tool name.
 */
export function detectDrift(
  baseline: BaselineShape,
  truth: CapabilitiesTruth,
  previousObservedTools: Set<string> = new Set(),
): DriftEvent[] {
  const events: DriftEvent[] = [];

  // 1. Env flag changes
  const baselineFlags = baseline.envFlags;
  const currentFlags = truth.env_flags;
  const flagKeys = Object.keys(currentFlags).sort() as Array<keyof EnvFlags>;
  for (const key of flagKeys) {
    const before = baselineFlags[key];
    const after = currentFlags[key];
    if (before !== after) {
      events.push({
        severity: SEVERITY.env_flag_changed,
        changeType: "env_flag_changed",
        detail: `${key}: ${String(before)} → ${String(after)}`,
        beforeValue: { [key]: before },
        afterValue: { [key]: after },
      });
    }
  }

  // 2/3. Tool add/remove
  const baselineTools = new Map(baseline.tools.map((t) => [t.tool, t]));
  const currentTools = new Map(
    truth.truth_table.map((t) => [t.tool, { tool: t.tool, category: t.category, in_schema: t.in_schema }]),
  );

  const added = [...currentTools.keys()].filter((t) => !baselineTools.has(t)).sort();
  const removed = [...baselineTools.keys()].filter((t) => !currentTools.has(t)).sort();

  for (const name of added) {
    events.push({
      severity: SEVERITY.tool_added,
      changeType: "tool_added",
      detail: `tool appeared in schema: ${name}`,
      beforeValue: null,
      afterValue: currentTools.get(name),
    });
  }
  for (const name of removed) {
    events.push({
      severity: SEVERITY.tool_removed,
      changeType: "tool_removed",
      detail: `tool disappeared from schema: ${name}`,
      beforeValue: baselineTools.get(name),
      afterValue: null,
    });
  }

  // 4. Silent regression
  const currentObservedSet = new Set(truth.observed_firing_24h.map((o) => o.tool));
  const silent = [...previousObservedTools]
    .filter((t) => currentTools.has(t))            // still in schema
    .filter((t) => !currentObservedSet.has(t))     // not observed this window
    .sort();
  for (const name of silent) {
    events.push({
      severity: SEVERITY.tool_went_silent,
      changeType: "tool_went_silent",
      detail: `tool did not fire in the last window: ${name}`,
      beforeValue: { tool: name, fired_last_window: true },
      afterValue: { tool: name, fired_last_window: false },
    });
  }

  return events;
}

// ── Classification helpers ───────────────────────────────────────────────────

/**
 * Events whose severity lets the baseline auto-update (per design doc #5).
 * Currently only env_flag_changed. Tool changes need human acknowledgement.
 */
export function isAutoAcknowledgeable(ev: DriftEvent): boolean {
  return ev.severity === "info";
}

export function hasBlockingEvents(events: DriftEvent[]): boolean {
  return events.some((e) => !isAutoAcknowledgeable(e));
}

/**
 * Self-Monitoring — drift detection unit tests.
 *
 * Pure logic; no DB / network / env. Validates the full event matrix:
 *   - env_flag_changed    (info)
 *   - tool_added          (critical)
 *   - tool_removed        (critical)
 *   - tool_went_silent    (warn)
 * plus classification helpers (isAutoAcknowledgeable, hasBlockingEvents).
 */
import { describe, it, expect } from "vitest";
import {
  detectDrift,
  isAutoAcknowledgeable,
  hasBlockingEvents,
  type BaselineShape,
} from "../../lib/self-monitoring/drift";
import type { CapabilitiesTruth } from "../../lib/self-monitoring/collect";

function baseline(overrides?: Partial<BaselineShape>): BaselineShape {
  return {
    envFlags: {
      LUCA_V1A_ENABLED: true,
      LUCA_EXPANDED_SCOPE_ENABLED: false,
      LUCA_APPROVAL_GATE_ENABLED: true,
      LUCA_APPROVAL_GATE_MODE: "log_only",
    },
    tools: [
      { tool: "luca_search", category: "v1a", in_schema: true },
      { tool: "luca_read_url", category: "v1a", in_schema: true },
      { tool: "studio_suggest_memory", category: "base", in_schema: true },
    ],
    ...overrides,
  };
}

function truth(overrides?: Partial<CapabilitiesTruth>): CapabilitiesTruth {
  return {
    generated_at: new Date().toISOString(),
    env_flags: {
      LUCA_V1A_ENABLED: true,
      LUCA_EXPANDED_SCOPE_ENABLED: false,
      LUCA_APPROVAL_GATE_ENABLED: true,
      LUCA_APPROVAL_GATE_MODE: "log_only",
    },
    scope_summary: { schema_total: 3, studio_base: 1, v1a: 2, observed_firing_24h: 0 },
    truth_table: [
      { tool: "luca_search", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
      { tool: "luca_read_url", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
      { tool: "studio_suggest_memory", category: "base", in_schema: true, observed_firing_24h: false, observed: null },
    ],
    observed_firing_24h: [],
    ...overrides,
  };
}

describe("self-monitoring/drift.detectDrift", () => {
  it("empty drift when baseline and truth match", () => {
    const evs = detectDrift(baseline(), truth());
    expect(evs).toEqual([]);
  });

  it("emits env_flag_changed (info) when a flag flips", () => {
    const t = truth({
      env_flags: {
        LUCA_V1A_ENABLED: true,
        LUCA_EXPANDED_SCOPE_ENABLED: true, // flipped
        LUCA_APPROVAL_GATE_ENABLED: true,
        LUCA_APPROVAL_GATE_MODE: "log_only",
      },
    });
    const evs = detectDrift(baseline(), t);
    expect(evs).toHaveLength(1);
    expect(evs[0].severity).toBe("info");
    expect(evs[0].changeType).toBe("env_flag_changed");
    expect(evs[0].detail).toContain("LUCA_EXPANDED_SCOPE_ENABLED");
    expect(evs[0].detail).toContain("false");
    expect(evs[0].detail).toContain("true");
  });

  it("emits tool_added (critical) when a new tool appears in schema", () => {
    const t = truth({
      truth_table: [
        { tool: "luca_search", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
        { tool: "luca_read_url", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
        { tool: "studio_suggest_memory", category: "base", in_schema: true, observed_firing_24h: false, observed: null },
        { tool: "gmail_read", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
      ],
    });
    const evs = detectDrift(baseline(), t);
    expect(evs).toHaveLength(1);
    expect(evs[0].severity).toBe("critical");
    expect(evs[0].changeType).toBe("tool_added");
    expect(evs[0].detail).toContain("gmail_read");
  });

  it("emits tool_removed (critical) when a baseline tool disappears", () => {
    const t = truth({
      truth_table: [
        { tool: "luca_search", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
        { tool: "studio_suggest_memory", category: "base", in_schema: true, observed_firing_24h: false, observed: null },
      ],
    });
    const evs = detectDrift(baseline(), t);
    expect(evs).toHaveLength(1);
    expect(evs[0].severity).toBe("critical");
    expect(evs[0].changeType).toBe("tool_removed");
    expect(evs[0].detail).toContain("luca_read_url");
  });

  it("emits tool_went_silent (warn) only for tools previously observed firing", () => {
    // Previous window observed luca_search firing; current window shows none.
    const prev = new Set<string>(["luca_search"]);
    const evs = detectDrift(baseline(), truth(), prev);
    expect(evs).toHaveLength(1);
    expect(evs[0].severity).toBe("warn");
    expect(evs[0].changeType).toBe("tool_went_silent");
    expect(evs[0].detail).toContain("luca_search");
  });

  it("does NOT emit tool_went_silent for tools never previously observed", () => {
    const evs = detectDrift(baseline(), truth(), new Set());
    // All quiet, nothing observed before → no silent regression.
    expect(evs.filter((e) => e.changeType === "tool_went_silent")).toEqual([]);
  });

  it("combines multiple drift classes and orders env → added → removed → silent", () => {
    const b = baseline();
    const t = truth({
      env_flags: {
        LUCA_V1A_ENABLED: true,
        LUCA_EXPANDED_SCOPE_ENABLED: true, // flag changed
        LUCA_APPROVAL_GATE_ENABLED: true,
        LUCA_APPROVAL_GATE_MODE: "log_only",
      },
      truth_table: [
        { tool: "luca_search", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
        { tool: "studio_suggest_memory", category: "base", in_schema: true, observed_firing_24h: false, observed: null },
        { tool: "gmail_read", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
      ],
    });
    const prev = new Set(["luca_search"]);
    const evs = detectDrift(b, t, prev);
    const kinds = evs.map((e) => e.changeType);
    expect(kinds).toEqual([
      "env_flag_changed",
      "tool_added",      // gmail_read
      "tool_removed",    // luca_read_url
      "tool_went_silent" // luca_search (was observed prev, not in current observed set)
    ]);
  });
});

describe("self-monitoring/drift.isAutoAcknowledgeable", () => {
  it("auto-acks only info events", () => {
    expect(isAutoAcknowledgeable({ severity: "info", changeType: "env_flag_changed", detail: "x", beforeValue: null, afterValue: null })).toBe(true);
    expect(isAutoAcknowledgeable({ severity: "warn", changeType: "tool_went_silent", detail: "x", beforeValue: null, afterValue: null })).toBe(false);
    expect(isAutoAcknowledgeable({ severity: "critical", changeType: "tool_added", detail: "x", beforeValue: null, afterValue: null })).toBe(false);
  });
});

describe("self-monitoring/drift.hasBlockingEvents", () => {
  it("false for empty / info-only", () => {
    expect(hasBlockingEvents([])).toBe(false);
    expect(hasBlockingEvents([{ severity: "info", changeType: "env_flag_changed", detail: "x", beforeValue: null, afterValue: null }])).toBe(false);
  });
  it("true when any warn or critical present", () => {
    expect(hasBlockingEvents([{ severity: "warn", changeType: "tool_went_silent", detail: "x", beforeValue: null, afterValue: null }])).toBe(true);
    expect(hasBlockingEvents([{ severity: "critical", changeType: "tool_added", detail: "x", beforeValue: null, afterValue: null }])).toBe(true);
  });
});

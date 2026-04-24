/**
 * Self-Monitoring — runHealthCheck integration with mocked collector + pool.
 *
 * Exercises the orchestration in health-job.ts across four scenarios:
 *   1. No baseline + seedIfMissing=true → creates baseline, drift_count=0.
 *   2. Baseline matches truth → drift_count=0, no alert.
 *   3. Info-only drift (env flag flipped) → auto-ack, baseline auto-promoted.
 *   4. Critical drift (tool_added) → baseline frozen, blocking_drift_count>0.
 *
 * State lives on globalThis so vi.mock factories (which are hoisted above
 * top-level test variables) can still read mutable state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Handler =
  | ((sql: string, params: any[]) => Promise<{ rows: any[]; rowCount?: number }>)
  | ((sql: string, params: any[]) => { rows: any[]; rowCount?: number });

// Shared state on globalThis ─ hoisting-safe.
const G = globalThis as any;
if (!G.__smTest) {
  G.__smTest = { handlers: [] as Array<{ pattern: RegExp; handler: Handler }>, sqlCalls: [] as any[], currentTruth: null };
}

function when(pattern: RegExp, handler: Handler) {
  G.__smTest.handlers.push({ pattern, handler });
}

vi.mock("../../storage", async () => {
  const actual = await vi.importActual<any>("../../storage");
  return {
    ...actual,
    pool: {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const GG = (globalThis as any).__smTest;
        GG.sqlCalls.push({ sql, params });
        for (const h of GG.handlers) {
          if (h.pattern.test(sql)) return await h.handler(sql, params);
        }
        return { rows: [], rowCount: 0 };
      }),
    },
  };
});

vi.mock("../../lib/self-monitoring/collect", async () => {
  const actual = await vi.importActual<any>("../../lib/self-monitoring/collect");
  return {
    ...actual,
    collectCapabilitiesTruth: vi.fn(async () => (globalThis as any).__smTest.currentTruth),
  };
});

vi.mock("../../lib/self-monitoring/webhook", () => ({
  sendAlert: vi.fn(async () => ({ delivered: true, status: 200 })),
}));

import { runHealthCheck } from "../../lib/self-monitoring/health-job";
import { sendAlert } from "../../lib/self-monitoring/webhook";

function baseTruth() {
  return {
    generated_at: "2026-04-23T00:00:00Z",
    env_flags: {
      LUCA_V1A_ENABLED: true,
      LUCA_EXPANDED_SCOPE_ENABLED: false,
      LUCA_APPROVAL_GATE_ENABLED: true,
      LUCA_APPROVAL_GATE_MODE: "log_only",
    },
    scope_summary: { schema_total: 2, studio_base: 1, v1a: 1, observed_firing_24h: 0 },
    truth_table: [
      { tool: "luca_search", category: "v1a", in_schema: true, observed_firing_24h: false, observed: null },
      { tool: "studio_suggest_memory", category: "base", in_schema: true, observed_firing_24h: false, observed: null },
    ],
    observed_firing_24h: [],
  };
}

beforeEach(() => {
  G.__smTest.handlers = [];
  G.__smTest.sqlCalls = [];
  (sendAlert as any).mockClear();
  G.__smTest.currentTruth = baseTruth();
});
afterEach(() => {
  G.__smTest.handlers = [];
  G.__smTest.sqlCalls = [];
});

// ── Scenario 1: no baseline + seed ───────────────────────────────────────────

describe("runHealthCheck — no baseline + seedIfMissing", () => {
  it("seeds baseline, returns drift_count=0, baseline_seeded=true", async () => {
    when(/FROM kioku_capabilities_baseline[\s\S]*WHERE is_active = true/i, () => ({ rows: [] }));
    when(/UPDATE kioku_capabilities_baseline SET is_active = false/i, () => ({ rows: [], rowCount: 0 }));
    when(/INSERT INTO kioku_capabilities_baseline/i, () => ({ rows: [{ id: 42 }] }));

    const r = await runHealthCheck({ seedIfMissing: true });
    expect(r.baseline_seeded).toBe(true);
    expect(r.drift_count).toBe(0);
    expect(r.blocking_drift_count).toBe(0);
    expect(r.baseline_id).toBe(42);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

// ── Scenario 2: baseline matches truth ───────────────────────────────────────

describe("runHealthCheck — baseline matches truth", () => {
  it("no drift events, no alerts", async () => {
    const t = baseTruth();
    when(/FROM kioku_capabilities_baseline[\s\S]*WHERE is_active = true/i, () => ({
      rows: [{
        id: 1,
        snapshot_at: 1000,
        env_flags: t.env_flags,
        tools: t.truth_table.map((x) => ({ tool: x.tool, category: x.category, in_schema: true })),
      }],
    }));

    const r = await runHealthCheck({ seedIfMissing: false });
    expect(r.drift_count).toBe(0);
    expect(r.blocking_drift_count).toBe(0);
    expect(r.baseline_seeded).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

// ── Scenario 3: info-only drift auto-promotes baseline ───────────────────────

describe("runHealthCheck — info-only drift (env flag flipped)", () => {
  it("persists drift, alerts, auto-promotes baseline", async () => {
    G.__smTest.currentTruth.env_flags.LUCA_EXPANDED_SCOPE_ENABLED = true;
    const baselineFlags = baseTruth().env_flags;

    let insertCount = 0;
    when(/FROM kioku_capabilities_baseline[\s\S]*WHERE is_active = true/i, () => ({
      rows: [{
        id: 1,
        snapshot_at: 1000,
        env_flags: baselineFlags,
        tools: baseTruth().truth_table.map((x) => ({ tool: x.tool, category: x.category, in_schema: true })),
      }],
    }));
    when(/INSERT INTO kioku_capabilities_drift_log/i, () => ({ rows: [{ id: 7 }] }));
    when(/UPDATE kioku_capabilities_drift_log[\s\S]*acknowledged = true/i, () => ({ rows: [], rowCount: 1 }));
    when(/UPDATE kioku_capabilities_drift_log[\s\S]*notified = true/i, () => ({ rows: [], rowCount: 1 }));
    when(/UPDATE kioku_capabilities_baseline SET is_active = false/i, () => ({ rows: [], rowCount: 1 }));
    when(/INSERT INTO kioku_capabilities_baseline/i, () => {
      insertCount += 1;
      return { rows: [{ id: 99 }] };
    });

    const r = await runHealthCheck({ seedIfMissing: false });
    expect(r.drift_count).toBe(1);
    expect(r.blocking_drift_count).toBe(0);
    expect(r.baseline_id).toBe(99);
    expect(insertCount).toBe(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});

// ── Scenario 4: critical drift freezes baseline ──────────────────────────────

describe("runHealthCheck — critical drift (tool_added) freezes baseline", () => {
  it("persists drift, alerts, but baseline_id unchanged", async () => {
    G.__smTest.currentTruth.truth_table.push({
      tool: "gmail_read",
      category: "v1a",
      in_schema: true,
      observed_firing_24h: false,
      observed: null,
    });
    const baseline = baseTruth();

    let insertCount = 0;
    when(/FROM kioku_capabilities_baseline[\s\S]*WHERE is_active = true/i, () => ({
      rows: [{
        id: 1,
        snapshot_at: 1000,
        env_flags: baseline.env_flags,
        tools: baseline.truth_table.map((x) => ({ tool: x.tool, category: x.category, in_schema: true })),
      }],
    }));
    when(/INSERT INTO kioku_capabilities_drift_log/i, () => ({ rows: [{ id: 8 }] }));
    when(/UPDATE kioku_capabilities_drift_log/i, () => ({ rows: [], rowCount: 1 }));
    when(/UPDATE kioku_capabilities_baseline SET is_active = false/i, () => ({ rows: [], rowCount: 1 }));
    when(/INSERT INTO kioku_capabilities_baseline/i, () => {
      insertCount += 1;
      return { rows: [{ id: 999 }] };
    });

    const r = await runHealthCheck({ seedIfMissing: false });
    expect(r.drift_count).toBeGreaterThanOrEqual(1);
    expect(r.blocking_drift_count).toBeGreaterThanOrEqual(1);
    expect(r.baseline_id).toBe(1); // unchanged
    expect(insertCount).toBe(0);
    expect(r.ok).toBe(false);
    expect(sendAlert).toHaveBeenCalled();
  });
});

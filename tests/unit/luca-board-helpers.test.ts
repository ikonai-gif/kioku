/**
 * Luca Day 7 — Tests for pure helpers backing the Approval Board UI.
 *
 * Why these exist: the component (`client/src/pages/luca-board.tsx`)
 * has no React Testing Library in the stack, so instead of rendering
 * we extracted decidability / validation / formatting logic into pure
 * functions and pin them here. The component is a thin wrapper that
 * delegates to these helpers — if they're right, the UI is right.
 */

import { describe, it, expect } from "vitest";
import {
  canExecuteApproval,
  canRejectApproval,
  countPending,
  parseEditPayload,
  formatRelative,
  formatExpiresIn,
  prettyJson,
  type ApprovalRowLite,
  type GateMode,
} from "@/lib/luca-board-helpers";

// Fixed reference "now" to keep tests deterministic.
const NOW = Date.UTC(2026, 3, 23, 17, 0, 0); // 2026-04-23T17:00:00Z
const IN_1H = new Date(NOW + 60 * 60 * 1000).toISOString();
const PAST_1H = new Date(NOW - 60 * 60 * 1000).toISOString();

function row(
  overrides: Partial<ApprovalRowLite> = {},
): ApprovalRowLite {
  return {
    status: "pending",
    expiresAt: IN_1H,
    ...overrides,
  };
}

describe("canExecuteApproval — gate mode & lifecycle gating", () => {
  it("returns true only for pending + not expired + block mode", () => {
    expect(canExecuteApproval(row(), "block", NOW)).toBe(true);
  });

  it("returns false in log_only mode — shadow rows would double-execute", () => {
    // This is the critical safety invariant: log_only rows already
    // ran the tool; approving them again re-runs the side effect.
    expect(canExecuteApproval(row(), "log_only", NOW)).toBe(false);
  });

  it("returns false when mode is unknown/null", () => {
    expect(canExecuteApproval(row(), null, NOW)).toBe(false);
  });

  it("returns false for expired rows even in block mode", () => {
    expect(
      canExecuteApproval(row({ expiresAt: PAST_1H }), "block", NOW),
    ).toBe(false);
  });

  it("returns false for non-pending rows", () => {
    for (const status of ["approved", "edited", "rejected", "timeout", "error"] as const) {
      expect(canExecuteApproval(row({ status }), "block", NOW)).toBe(false);
    }
  });
});

describe("canRejectApproval — safe in any mode", () => {
  it("returns true for pending + not expired regardless of mode", () => {
    // Reject is a status-only flip with no side effect.
    expect(canRejectApproval(row(), NOW)).toBe(true);
  });

  it("returns false for expired rows", () => {
    expect(canRejectApproval(row({ expiresAt: PAST_1H }), NOW)).toBe(false);
  });

  it("returns false for non-pending rows", () => {
    for (const status of ["approved", "rejected", "timeout"] as const) {
      expect(canRejectApproval(row({ status }), NOW)).toBe(false);
    }
  });
});

describe("countPending", () => {
  it("counts only status=pending", () => {
    expect(
      countPending([
        row({ status: "pending" }),
        row({ status: "pending" }),
        row({ status: "approved" }),
        row({ status: "rejected" }),
        row({ status: "timeout" }),
      ]),
    ).toBe(2);
  });

  it("returns 0 for empty list", () => {
    expect(countPending([])).toBe(0);
  });
});

describe("parseEditPayload — defensive JSON parsing", () => {
  it("accepts a plain object", () => {
    const r = parseEditPayload('{"path": "x.txt", "content": "hi"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ path: "x.txt", content: "hi" });
    }
  });

  it("rejects invalid JSON with a human-readable error", () => {
    const r = parseEditPayload("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("invalid json");
  });

  it("rejects arrays (tool args are always objects)", () => {
    const r = parseEditPayload("[1,2,3]");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/object.*not an array/i);
  });

  it("rejects primitives", () => {
    for (const v of ['"hello"', "42", "true", "null"]) {
      const r = parseEditPayload(v);
      expect(r.ok).toBe(false);
    }
  });

  it("accepts empty object", () => {
    const r = parseEditPayload("{}");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });
});

describe("formatRelative", () => {
  it("seconds", () => {
    expect(
      formatRelative(new Date(NOW - 30 * 1000).toISOString(), NOW),
    ).toBe("30s ago");
  });
  it("minutes", () => {
    expect(
      formatRelative(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW),
    ).toBe("5m ago");
  });
  it("hours", () => {
    expect(
      formatRelative(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW),
    ).toBe("3h ago");
  });
  it("days", () => {
    expect(
      formatRelative(new Date(NOW - 2 * 86400 * 1000).toISOString(), NOW),
    ).toBe("2d ago");
  });
  it("null returns em-dash", () => {
    expect(formatRelative(null, NOW)).toBe("—");
  });
});

describe("formatExpiresIn", () => {
  it("shows seconds when close", () => {
    expect(formatExpiresIn(new Date(NOW + 45 * 1000).toISOString(), NOW)).toBe("45s");
  });
  it("shows minutes", () => {
    expect(formatExpiresIn(new Date(NOW + 10 * 60 * 1000).toISOString(), NOW)).toBe("10m");
  });
  it("returns 'expired' for past times", () => {
    expect(formatExpiresIn(PAST_1H, NOW)).toBe("expired");
  });
  it("returns 'expired' at exactly now (boundary)", () => {
    expect(formatExpiresIn(new Date(NOW).toISOString(), NOW)).toBe("expired");
  });
});

describe("prettyJson", () => {
  it("indents 2 spaces", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
  it("handles circular refs without throwing", () => {
    const a: any = { name: "x" };
    a.self = a;
    // Should not throw — falls back to String(v)
    expect(() => prettyJson(a)).not.toThrow();
  });
});

// ── Safety matrix — the critical double-execute invariant ────────────
describe("safety invariant: log_only never permits execution", () => {
  const cases: Array<{ mode: GateMode; label: string }> = [
    { mode: "block", label: "block" },
    { mode: "log_only", label: "log_only" },
    { mode: null, label: "unknown" },
  ];
  for (const { mode, label } of cases) {
    it(`mode=${label} — canExecuteApproval matches safety rules`, () => {
      const pendingActive = row();
      const expected = mode === "block";
      expect(canExecuteApproval(pendingActive, mode, NOW)).toBe(expected);
    });
  }
});

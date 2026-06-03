/**
 * R471 (BRO2) — Phase-1 of Luca's gated build loop.
 * Tests the OPTIONAL patch_diff / test_report fields added to the proposal
 * validator. These let Luca attach a concrete diff + her own test output to a
 * proposal. They are inert: absent → omitted; present → capped + NUL-stripped.
 * No branch, no PR, no auto-apply (verified at the design level, not here).
 */
import { describe, it, expect } from "vitest";
import { validateProposalInput } from "../../lib/luca-tools/propose-improvement";

const base = { title: "Add foo", body: "because bar", category: "tool" };

describe("validateProposalInput — Phase-1 patch fields", () => {
  it("accepts a proposal with no patch fields (backward compatible)", () => {
    const r = validateProposalInput({ ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.patchDiff).toBeUndefined();
      expect(r.value.testReport).toBeUndefined();
    }
  });

  it("accepts a valid unified diff and test report", () => {
    const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@\n-old\n+new\n";
    const report = "Test Files 1 passed (1)\nTests 3 passed (3)";
    const r = validateProposalInput({ ...base, patch_diff: diff, test_report: report });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.patchDiff).toBe(diff);
      expect(r.value.testReport).toBe(report);
    }
  });

  it("treats empty-string patch fields as absent", () => {
    const r = validateProposalInput({ ...base, patch_diff: "", test_report: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.patchDiff).toBeUndefined();
      expect(r.value.testReport).toBeUndefined();
    }
  });

  it("rejects an over-long patch_diff", () => {
    const r = validateProposalInput({ ...base, patch_diff: "x".repeat(200_001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("patch_too_long");
  });

  it("rejects an over-long test_report", () => {
    const r = validateProposalInput({ ...base, test_report: "y".repeat(50_001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("test_report_too_long");
  });

  it("rejects NUL bytes in patch_diff", () => {
    const r = validateProposalInput({ ...base, patch_diff: "a\0b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });

  it("rejects NUL bytes in test_report", () => {
    const r = validateProposalInput({ ...base, test_report: "a\0b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });

  it("rejects a non-string patch_diff", () => {
    const r = validateProposalInput({ ...base, patch_diff: 123 as any });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_chars");
  });

  it("still enforces existing rules (missing body) regardless of patch", () => {
    const r = validateProposalInput({ title: "t", body: "  ", category: "tool", patch_diff: "diff" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_body");
  });
});

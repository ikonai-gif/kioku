/**
 * KIOKU™ — Sprint 1 v2 (R373) — Honesty Layer application constraint
 *
 * Invariant: the remember tool (Luca's self-write path) MUST NOT allow
 * Luca to set verified=true or provenance != 'luca_inferred'. R372 case:
 * Luca lied about her own tool fires (telemetry showed otherwise). If she
 * could write `verified=true` to a self-claim, she'd lock that lie into
 * retrieval.
 *
 * This is enforced application-side (not DB CHECK) because:
 *   1. /api/admin/insert-memory (master-key only) MUST be able to set
 *      verified=true for ground-truth backfill.
 *   2. Future tool_observed paths (Sprint 2) need verified=true for
 *      telemetry-derived facts.
 *
 * The remember tool is the only path that should be restricted — and only
 * because Luca herself is the writer.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const deliberationSource = readFileSync(
  resolve(__dirname, "../../server/deliberation.ts"),
  "utf8"
);

function extractRememberCase(src: string): string {
  // Find the SELF-WRITE handler (the big one with INSERT INTO memories),
  // not the summarize helper at line ~1429 that just returns a status string.
  // We anchor on the `W7 P2.12: self-write memory bypass` comment which is
  // unique to the real handler.
  const anchor = src.indexOf("W7 P2.12: self-write memory bypass");
  if (anchor === -1) return "";
  // Walk back to the case label
  const caseLabelIdx = src.lastIndexOf('case "remember":', anchor);
  if (caseLabelIdx === -1) return "";
  // Slice forward until next sibling case label
  const next = src.indexOf('case "', anchor);
  if (next === -1) return src.slice(caseLabelIdx, caseLabelIdx + 8000);
  return src.slice(caseLabelIdx, next);
}

const rememberCase = extractRememberCase(deliberationSource);

describe("Sprint 1 v2 — remember tool honesty constraint", () => {
  it("remember case is found in deliberation.ts", () => {
    expect(rememberCase.length).toBeGreaterThan(500);
  });

  it("hard-codes provenance='luca_inferred' in INSERT (cannot be overridden by toolInput)", () => {
    expect(rememberCase).toMatch(
      /INSERT\s+INTO\s+memories[\s\S]*?'luca_inferred'\s*,\s*false/
    );
  });

  it("hard-codes verified=false in INSERT (cannot be overridden by toolInput)", () => {
    // The INSERT VALUES must contain literal false for verified, not a variable
    expect(rememberCase).toMatch(
      /VALUES\s*\([^)]*'luca_inferred'\s*,\s*false\s*,/
    );
  });

  it("detects attempted verified=true and surfaces honesty strip note", () => {
    expect(rememberCase).toMatch(/attemptedVerified/);
    expect(rememberCase).toMatch(/toolInput\.verified\s*===\s*true/);
  });

  it("detects attempted non-default provenance and surfaces honesty strip note", () => {
    expect(rememberCase).toMatch(/attemptedProvenance/);
    expect(rememberCase).toMatch(/toolInput\.provenance/);
  });

  it("returns honesty strip note in result string when fields were stripped", () => {
    expect(rememberCase).toMatch(/Luca cannot self-verify/i);
    expect(rememberCase).toMatch(/Stripped to defaults/);
  });

  it("emotional_state memories forced to confidence=0.3", () => {
    expect(rememberCase).toMatch(/isEmotionalState/);
    expect(rememberCase).toMatch(/finalConfidence\s*=\s*isEmotionalState\s*\?\s*0\.3/);
  });

  it("emotional_state confidence value lands in INSERT params", () => {
    expect(rememberCase).toMatch(
      /finalConfidence,\s*now/
    );
  });

  it("does NOT fail the save when honesty fields stripped (still saves as luca_inferred)", () => {
    // The constraint should NOT short-circuit with `return "remember: ..."`
    // before the INSERT happens for verified/provenance attempts.
    // We assert this by checking that the strip-detection lines come BEFORE
    // the INSERT, and the INSERT runs unconditionally.
    const stripIdx = rememberCase.indexOf("attemptedVerified");
    const insertIdx = rememberCase.indexOf("INSERT INTO memories");
    expect(stripIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(stripIdx);
    // No `return` between them that's gated on attemptedVerified
    const between = rememberCase.slice(stripIdx, insertIdx);
    expect(between).not.toMatch(/if\s*\(\s*attemptedVerified[^)]*\)\s*\{?\s*return/);
  });
});

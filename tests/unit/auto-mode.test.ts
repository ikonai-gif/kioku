/**
 * [BRO2-A11 / LUCA-073 variant A] Auto mode PR1 — unit tests.
 * Covers: flag semantics (default off, explicit true only), eligibility
 * (HIGH_STAKES/UNKNOWN never auto), marker chokepoint, and the static
 * contract that recordLucaAudit persists auto_mode.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  isAutoModeEnabled,
  isAutoEligible,
  autoModeMarker,
} from "../../server/lib/luca-tools/auto-mode";

describe("auto-mode — kill-switch flag (LUCA-073 §4, variant A)", () => {
  it("defaults to OFF when unset", () => {
    expect(isAutoModeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it("OFF for anything except explicit 'true'", () => {
    for (const v of ["false", "1", "yes", "TRUE ", "on", ""]) {
      const expected = v.trim().toLowerCase() === "true";
      expect(isAutoModeEnabled({ LUCA_AUTO_MODE_ENABLED: v } as NodeJS.ProcessEnv)).toBe(expected);
    }
  });
  it("ON only for 'true' (case/space tolerant)", () => {
    expect(isAutoModeEnabled({ LUCA_AUTO_MODE_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAutoModeEnabled({ LUCA_AUTO_MODE_ENABLED: " True " } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("auto-mode — eligibility (BOSS HARD RULE)", () => {
  it("READ_ONLY and LOW_STAKES_WRITE are eligible", () => {
    expect(isAutoEligible("READ_ONLY")).toBe(true);
    expect(isAutoEligible("LOW_STAKES_WRITE")).toBe(true);
  });
  it("HIGH_STAKES_WRITE, UNKNOWN, and garbage are NEVER eligible", () => {
    for (const c of ["HIGH_STAKES_WRITE", "UNKNOWN", "", "read_only", "anything"]) {
      expect(isAutoEligible(c)).toBe(false);
    }
  });
});

describe("auto-mode — marker chokepoint", () => {
  const on = { LUCA_AUTO_MODE_ENABLED: "true" } as NodeJS.ProcessEnv;
  const off = {} as NodeJS.ProcessEnv;
  it("flag off → never marks, regardless of class", () => {
    expect(autoModeMarker("READ_ONLY", off)).toBe(false);
    expect(autoModeMarker("LOW_STAKES_WRITE", off)).toBe(false);
  });
  it("flag on → marks only eligible classes", () => {
    expect(autoModeMarker("READ_ONLY", on)).toBe(true);
    expect(autoModeMarker("LOW_STAKES_WRITE", on)).toBe(true);
    expect(autoModeMarker("HIGH_STAKES_WRITE", on)).toBe(false);
    expect(autoModeMarker("UNKNOWN", on)).toBe(false);
  });
});

describe("auto-mode — audit persistence contract (static)", () => {
  const audit = readFileSync(
    path.join(__dirname, "../../server/lib/luca-tools/audit-log.ts"),
    "utf8",
  );
  it("recordLucaAudit inserts auto_mode via autoModeMarker", () => {
    expect(audit).toContain("auto_mode");
    expect(audit).toContain("autoModeMarker");
  });
  const schema = readFileSync(path.join(__dirname, "../../shared/schema.ts"), "utf8");
  it("schema mirrors the auto_mode column", () => {
    expect(schema).toContain('boolean("auto_mode")');
  });
});

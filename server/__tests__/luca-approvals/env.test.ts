/**
 * Luca Day 6 — env.ts additions (approval gate flags + consistency check).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertLucaEnvConsistency,
  isApprovalGateActive,
  isApprovalGateEnforcing,
  readLucaEnv,
} from "../../lib/luca/env";

/**
 * Snapshot + restore every env var we touch so tests are isolated.
 */
const VARS = [
  "LUCA_V1A_ENABLED",
  "LUCA_TOOLS_ENABLED",
  "LUCA_APPROVAL_GATE_ENABLED",
  "LUCA_APPROVAL_GATE_MODE",
  "LUCA_EXPANDED_SCOPE_ENABLED",
];
let snapshot: Record<string, string | undefined>;

beforeEach(() => {
  snapshot = {};
  for (const v of VARS) snapshot[v] = process.env[v];
  for (const v of VARS) delete process.env[v];
});
afterEach(() => {
  for (const v of VARS) {
    if (snapshot[v] === undefined) delete process.env[v];
    else process.env[v] = snapshot[v];
  }
});

describe("env: approval gate flags parse correctly", () => {
  it("LUCA_APPROVAL_GATE_ENABLED defaults false", () => {
    expect(readLucaEnv().LUCA_APPROVAL_GATE_ENABLED).toBe(false);
  });

  it("LUCA_APPROVAL_GATE_ENABLED parses 'true' as true", () => {
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    expect(readLucaEnv().LUCA_APPROVAL_GATE_ENABLED).toBe(true);
  });

  it("LUCA_APPROVAL_GATE_ENABLED parses other values as false (1 is not true)", () => {
    process.env.LUCA_APPROVAL_GATE_ENABLED = "1";
    expect(readLucaEnv().LUCA_APPROVAL_GATE_ENABLED).toBe(false);
    process.env.LUCA_APPROVAL_GATE_ENABLED = "yes";
    expect(readLucaEnv().LUCA_APPROVAL_GATE_ENABLED).toBe(false);
  });

  it("LUCA_APPROVAL_GATE_MODE defaults 'block'", () => {
    expect(readLucaEnv().LUCA_APPROVAL_GATE_MODE).toBe("block");
  });

  it("LUCA_APPROVAL_GATE_MODE accepts 'log_only'", () => {
    process.env.LUCA_APPROVAL_GATE_MODE = "log_only";
    expect(readLucaEnv().LUCA_APPROVAL_GATE_MODE).toBe("log_only");
  });

  it("LUCA_APPROVAL_GATE_MODE falls back to 'block' on garbage", () => {
    process.env.LUCA_APPROVAL_GATE_MODE = "banana";
    expect(readLucaEnv().LUCA_APPROVAL_GATE_MODE).toBe("block");
  });

  it("LUCA_EXPANDED_SCOPE_ENABLED defaults false", () => {
    expect(readLucaEnv().LUCA_EXPANDED_SCOPE_ENABLED).toBe(false);
  });

  it("LUCA_EXPANDED_SCOPE_ENABLED parses 'true' as true", () => {
    process.env.LUCA_EXPANDED_SCOPE_ENABLED = "true";
    expect(readLucaEnv().LUCA_EXPANDED_SCOPE_ENABLED).toBe(true);
  });
});

describe("env: isApprovalGateActive / isApprovalGateEnforcing", () => {
  it("isApprovalGateActive false when flag off", () => {
    expect(isApprovalGateActive()).toBe(false);
  });

  it("isApprovalGateActive true when flag on", () => {
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    expect(isApprovalGateActive()).toBe(true);
  });

  it("isApprovalGateEnforcing true when flag on AND mode=block", () => {
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    expect(isApprovalGateEnforcing()).toBe(true);
  });

  it("isApprovalGateEnforcing false when flag on but mode=log_only", () => {
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    process.env.LUCA_APPROVAL_GATE_MODE = "log_only";
    expect(isApprovalGateEnforcing()).toBe(false);
    // Still "active"
    expect(isApprovalGateActive()).toBe(true);
  });

  it("isApprovalGateEnforcing false when flag off (mode irrelevant)", () => {
    process.env.LUCA_APPROVAL_GATE_MODE = "block";
    expect(isApprovalGateEnforcing()).toBe(false);
  });
});

describe("env: assertLucaEnvConsistency", () => {
  it("passes when everything is off", () => {
    expect(() => assertLucaEnvConsistency()).not.toThrow();
  });

  it("passes when V1A=true, gate off, expanded off", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    expect(() => assertLucaEnvConsistency()).not.toThrow();
  });

  it("passes when V1A=true, gate=true, expanded=true", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    process.env.LUCA_EXPANDED_SCOPE_ENABLED = "true";
    expect(() => assertLucaEnvConsistency()).not.toThrow();
  });

  it("throws when EXPANDED=true but GATE=false (danger: un-gated sends)", () => {
    process.env.LUCA_V1A_ENABLED = "true";
    process.env.LUCA_EXPANDED_SCOPE_ENABLED = "true";
    expect(() => assertLucaEnvConsistency()).toThrow(/luca_env_inconsistent/);
    expect(() => assertLucaEnvConsistency()).toThrow(
      /EXPANDED_SCOPE_ENABLED=true requires LUCA_APPROVAL_GATE_ENABLED=true/,
    );
  });

  it("throws when GATE=true but V1A=false", () => {
    process.env.LUCA_APPROVAL_GATE_ENABLED = "true";
    expect(() => assertLucaEnvConsistency()).toThrow(/luca_env_inconsistent/);
    expect(() => assertLucaEnvConsistency()).toThrow(
      /APPROVAL_GATE_ENABLED=true requires LUCA_V1A_ENABLED=true/,
    );
  });

  it("surfaces the EXPANDED error first when both inconsistencies exist", () => {
    // EXPANDED=true + GATE=false implies V1A=false too, but we report the
    // EXPANDED violation first since it's the more dangerous one (expanded
    // scope includes write tools that would bypass the gate entirely).
    process.env.LUCA_EXPANDED_SCOPE_ENABLED = "true";
    expect(() => assertLucaEnvConsistency()).toThrow(/EXPANDED_SCOPE/);
  });

  it("is callable with an explicit env override (for tests that don't want to mutate process.env)", () => {
    const good = {
      LUCA_V1A_ENABLED: true,
      LUCA_APPROVAL_GATE_ENABLED: true,
      LUCA_APPROVAL_GATE_MODE: "block" as const,
      LUCA_EXPANDED_SCOPE_ENABLED: true,
      LUCA_S3_BUCKET: null,
      AWS_REGION: null,
      LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC: false,
      LUCA_DRIVE_ROOT_FOLDER: null,
      BRAVE_SEARCH_API_KEY: null,
      LUCA_TOOLS_ENABLED: false,
      LUCA_TOOL_RUN_CODE_ENABLED: false,
      LUCA_TOOL_ANALYZE_IMAGE_ENABLED: false,
      LUCA_TOOL_SEARCH_ENABLED: false,
      LUCA_TOOL_READ_URL_ENABLED: false,
      LUCA_TOOL_READ_MEMORY_ENABLED: false,
      LUCA_TOOL_WRITE_MEMORY_ENABLED: false,
      LUCA_TOOL_READ_FILE_ENABLED: false,
      LUCA_TOOL_UPLOAD_FILE_ENABLED: false,
    };
    expect(() => assertLucaEnvConsistency(good)).not.toThrow();

    const bad = { ...good, LUCA_V1A_ENABLED: false };
    expect(() => assertLucaEnvConsistency(bad)).toThrow(/luca_env_inconsistent/);
  });
});

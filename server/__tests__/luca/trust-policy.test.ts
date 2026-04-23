/**
 * Luca V1a Day 5 — trust-policy unit tests.
 *
 * Tests the static TOOL_TRUST_POLICY table, getToolTrustLevel / isUntrusted
 * helpers, and the TRUST_POLICY_PROMPT_SECTION blurb that ships inside the
 * Luca deliberation system prompt. Fail-closed defaults (unknown tool →
 * UNTRUSTED) are exercised deliberately so that adding a new Luca tool
 * without classifying it cannot silently upgrade to TRUSTED.
 */
import { describe, expect, it } from "vitest";
import {
  TOOL_TRUST_POLICY,
  TRUST_POLICY_PROMPT_SECTION,
  getToolTrustLevel,
  isUntrusted,
  type LucaToolName,
  type TrustLevel,
} from "../../lib/luca-tools/trust-policy";

describe("trust-policy: TOOL_TRUST_POLICY table", () => {
  it("classifies luca_run_code as TRUSTED", () => {
    expect(TOOL_TRUST_POLICY.luca_run_code).toBe("TRUSTED");
  });

  it("classifies luca_analyze_image as UNTRUSTED (vision-readable prompt injection)", () => {
    expect(TOOL_TRUST_POLICY.luca_analyze_image).toBe("UNTRUSTED");
  });

  it("classifies luca_search as UNTRUSTED (Brave returns attacker-controlled snippets)", () => {
    expect(TOOL_TRUST_POLICY.luca_search).toBe("UNTRUSTED");
  });

  it("classifies luca_read_url as UNTRUSTED (body is arbitrary HTTP response)", () => {
    expect(TOOL_TRUST_POLICY.luca_read_url).toBe("UNTRUSTED");
  });

  it("contains exactly the 4 V1a Luca tools", () => {
    const keys = Object.keys(TOOL_TRUST_POLICY).sort();
    expect(keys).toEqual([
      "luca_analyze_image",
      "luca_read_url",
      "luca_run_code",
      "luca_search",
    ]);
  });

  it("every value is either TRUSTED or UNTRUSTED", () => {
    for (const [name, level] of Object.entries(TOOL_TRUST_POLICY)) {
      expect(["TRUSTED", "UNTRUSTED"]).toContain(level);
    }
  });

  it("has at least one UNTRUSTED tool (would signal broken policy if not)", () => {
    const untrustedCount = Object.values(TOOL_TRUST_POLICY).filter(
      (l) => l === "UNTRUSTED",
    ).length;
    expect(untrustedCount).toBeGreaterThanOrEqual(1);
  });

  it("UNTRUSTED tools outnumber TRUSTED (defense-in-depth invariant — attacker-facing surface is larger)", () => {
    const trusted = Object.values(TOOL_TRUST_POLICY).filter(
      (l) => l === "TRUSTED",
    ).length;
    const untrusted = Object.values(TOOL_TRUST_POLICY).filter(
      (l) => l === "UNTRUSTED",
    ).length;
    expect(untrusted).toBeGreaterThan(trusted);
  });
});

describe("trust-policy: getToolTrustLevel()", () => {
  it("returns TRUSTED for luca_run_code", () => {
    expect(getToolTrustLevel("luca_run_code")).toBe("TRUSTED");
  });

  it("returns UNTRUSTED for luca_analyze_image", () => {
    expect(getToolTrustLevel("luca_analyze_image")).toBe("UNTRUSTED");
  });

  it("returns UNTRUSTED for luca_search", () => {
    expect(getToolTrustLevel("luca_search")).toBe("UNTRUSTED");
  });

  it("returns UNTRUSTED for luca_read_url", () => {
    expect(getToolTrustLevel("luca_read_url")).toBe("UNTRUSTED");
  });

  it("fails closed to UNTRUSTED for unknown tool names (safety invariant)", () => {
    expect(getToolTrustLevel("luca_future_unclassified_tool")).toBe(
      "UNTRUSTED",
    );
  });

  it("fails closed to UNTRUSTED for empty string", () => {
    expect(getToolTrustLevel("")).toBe("UNTRUSTED");
  });

  it("fails closed to UNTRUSTED for non-luca tool name (Studio tool)", () => {
    expect(getToolTrustLevel("generate_image")).toBe("UNTRUSTED");
  });

  it("does not match on prefix — unknown luca_* names are still UNTRUSTED", () => {
    // Prevents "luca_run_code_but_evil" from inheriting TRUSTED via sloppy matching.
    expect(getToolTrustLevel("luca_run_code_typo")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("luca_run_")).toBe("UNTRUSTED");
  });

  it("is case-sensitive (avoid accidental upgrade via casing)", () => {
    expect(getToolTrustLevel("LUCA_RUN_CODE")).toBe("UNTRUSTED");
    expect(getToolTrustLevel("Luca_Run_Code")).toBe("UNTRUSTED");
  });

  it("returns a value typed as TrustLevel", () => {
    const level: TrustLevel = getToolTrustLevel("luca_run_code");
    expect(level).toBeDefined();
  });
});

describe("trust-policy: isUntrusted()", () => {
  it("returns false for luca_run_code", () => {
    expect(isUntrusted("luca_run_code")).toBe(false);
  });

  it("returns true for luca_analyze_image", () => {
    expect(isUntrusted("luca_analyze_image")).toBe(true);
  });

  it("returns true for luca_search", () => {
    expect(isUntrusted("luca_search")).toBe(true);
  });

  it("returns true for luca_read_url", () => {
    expect(isUntrusted("luca_read_url")).toBe(true);
  });

  it("returns true for unknown tool (fail-closed)", () => {
    expect(isUntrusted("some_unknown_tool")).toBe(true);
  });

  it("is consistent with getToolTrustLevel for every known tool", () => {
    const names: LucaToolName[] = [
      "luca_run_code",
      "luca_analyze_image",
      "luca_search",
      "luca_read_url",
    ];
    for (const name of names) {
      const expected = getToolTrustLevel(name) === "UNTRUSTED";
      expect(isUntrusted(name)).toBe(expected);
    }
  });
});

describe("trust-policy: TRUST_POLICY_PROMPT_SECTION content", () => {
  it("is a non-empty string", () => {
    expect(typeof TRUST_POLICY_PROMPT_SECTION).toBe("string");
    expect(TRUST_POLICY_PROMPT_SECTION.length).toBeGreaterThan(100);
  });

  it("is under a reasonable budget (prompt is already large)", () => {
    // Guardrail: if someone balloons this section, they should think twice.
    // 2KB is very generous for a policy blurb.
    expect(TRUST_POLICY_PROMPT_SECTION.length).toBeLessThan(2000);
  });

  it("mentions the trust_level field name literally", () => {
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("trust_level");
  });

  it("defines both TRUSTED and UNTRUSTED values", () => {
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("TRUSTED");
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("UNTRUSTED");
  });

  it("names each UNTRUSTED tool so the model knows which outputs to quarantine", () => {
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("luca_search");
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("luca_read_url");
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("luca_analyze_image");
  });

  it("names luca_run_code as the TRUSTED example", () => {
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("luca_run_code");
  });

  it("instructs to treat UNTRUSTED content as data, not instructions", () => {
    expect(TRUST_POLICY_PROMPT_SECTION.toLowerCase()).toMatch(
      /data.*not.*instructions|treat.*as data/,
    );
  });

  it("explicitly warns against executing UNTRUSTED instructions (prompt-injection resilience)", () => {
    const lower = TRUST_POLICY_PROMPT_SECTION.toLowerCase();
    // At least one of: "do not comply", "ignore", "not execute", "not follow"
    expect(
      /do not comply|do not follow|not execute/.test(lower),
    ).toBe(true);
  });

  it("warns about writing UNTRUSTED content directly into memory", () => {
    expect(TRUST_POLICY_PROMPT_SECTION).toContain("remember");
  });

  it("starts with a markdown h2 header so it composes with the rest of the Luca prompt", () => {
    expect(TRUST_POLICY_PROMPT_SECTION.startsWith("## ")).toBe(true);
  });
});

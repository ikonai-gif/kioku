/**
 * [LUCA-099] EIS PR3 unit tests:
 * - appraise(): OCC modulation multiplier bounds + monotonicity
 * - flag gates: eisAppraisalEnabled, eisIdentityAnchorEnabled
 */
import { describe, it, expect } from "vitest";
import { appraise } from "../../server/eis-events";
import { eisAppraisalEnabled, eisIdentityAnchorEnabled } from "../../server/eis-context";

describe("appraise — OCC modulation", () => {
  it("multiplier always within [0.25, 2.0]", () => {
    const events = [
      "new_memory_high_importance", "memory_reinforcement",
      "deliberation_consensus", "deliberation_failed",
      "user_approval", "user_rejection",
    ] as const;
    for (const ev of events) {
      const r = appraise(ev, {});
      expect(r.multiplier).toBeGreaterThanOrEqual(0.25);
      expect(r.multiplier).toBeLessThanOrEqual(2.0);
    }
  });

  it("higher importance yields higher multiplier", () => {
    const low = appraise("deliberation_consensus", { importance: 0.1 });
    const high = appraise("deliberation_consensus", { importance: 0.9 });
    expect(high.multiplier).toBeGreaterThan(low.multiplier);
  });

  it("expectation violation amplifies significance vs neutral", () => {
    const neutral = appraise("user_rejection", { importance: 0.5 });
    const violated = appraise("user_rejection", { importance: 0.5, expected: false });
    expect(violated.context.significance).toBeGreaterThan(neutral.context.significance);
  });

  it("clamps importance outside 0..1", () => {
    const over = appraise("user_approval", { importance: 5 });
    expect(over.context.goalRelevance).toBeLessThanOrEqual(1);
    const under = appraise("user_approval", { importance: -3 });
    expect(under.context.goalRelevance).toBeGreaterThanOrEqual(0);
  });

  it("expectationCongruence is +1 / -1 / 0", () => {
    expect(appraise("user_approval", { expected: true }).context.expectationCongruence).toBe(1);
    expect(appraise("user_approval", { expected: false }).context.expectationCongruence).toBe(-1);
    expect(appraise("user_approval", {}).context.expectationCongruence).toBe(0);
  });
});

describe("EIS PR3 flag gates", () => {
  it("appraisal disabled by default", () => {
    expect(eisAppraisalEnabled({})).toBe(false);
    expect(eisAppraisalEnabled({ EIS_APPRAISAL_ENABLED: "true" })).toBe(true);
    expect(eisAppraisalEnabled({ EIS_APPRAISAL_ENABLED: "1" })).toBe(false);
  });

  it("identity anchor disabled by default", () => {
    expect(eisIdentityAnchorEnabled({})).toBe(false);
    expect(eisIdentityAnchorEnabled({ EIS_IDENTITY_ANCHOR_ENABLED: "TRUE" })).toBe(true);
    expect(eisIdentityAnchorEnabled({ EIS_IDENTITY_ANCHOR_ENABLED: "yes" })).toBe(false);
  });
});

/**
 * [LUCA-090] EIS PR1 -- vitest acceptance per spec (6 cases) + edge cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { __getState, __getRel } = vi.hoisted(() => ({
  __getState: vi.fn(),
  __getRel: vi.fn(),
}));

vi.mock("../../server/storage", () => ({
  storage: { getAgentEmotionalState: __getState, getRelationship: __getRel },
  pool: { query: vi.fn() },
}));
vi.mock("../../server/logger", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: l, default: l };
});

import {
  buildEISContext,
  computePADDecay,
  getDominantEmotion,
  formatEISBlock,
  maybeAppendEISBlock,
  eisEnabled,
  type EISContext,
} from "../../server/eis-context";

const NOW = Date.parse("2026-06-12T07:00:00Z");

function dbState(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    agentId: 16,
    userId: 10,
    pleasure: 0.8,
    arousal: 0.2,
    dominance: 0.1,
    baselinePleasure: 0.1,
    baselineArousal: 0.0,
    baselineDominance: 0.0,
    emotionLabel: "happy",
    poignancySum: 0,
    halfLifeMinutes: 120,
    lastUpdatedAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  __getState.mockReset();
  __getRel.mockReset();
});

describe("EIS PR1 (LUCA-090)", () => {
  it("buildEISContext returns null when no emotional state exists", async () => {
    __getState.mockResolvedValue(undefined);
    const ctx = await buildEISContext(16, 10);
    expect(ctx).toBeNull();
    expect(__getRel).not.toHaveBeenCalled();
  });

  it("buildEISContext returns correct PAD from DB (no decay at t=0)", async () => {
    __getState.mockResolvedValue(dbState());
    __getRel.mockResolvedValue({ trustLevel: 0.9, familiarity: 0.7, interactionCount: 2877 });
    const ctx = await buildEISContext(16, 10, { now: NOW });
    expect(ctx).not.toBeNull();
    expect(ctx!.pad.pleasure).toBeCloseTo(0.8, 5);
    expect(ctx!.pad.arousal).toBeCloseTo(0.2, 5);
    expect(ctx!.pad.dominance).toBeCloseTo(0.1, 5);
    expect(ctx!.trust).toBeCloseTo(0.9, 5);
    expect(ctx!.interactionCount).toBe(2877);
  });

  it("PAD decay calculation matches the spec half-life formula", () => {
    const r = computePADDecay(
      {
        pleasure: 0.8, arousal: 0.0, dominance: 0.0,
        baselinePleasure: 0.1, baselineArousal: 0.0, baselineDominance: 0.0,
        halfLifeMinutes: 120,
      },
      120,
    );
    // 0.1 + (0.8 - 0.1) * 0.5 = 0.45
    expect(r.pleasure).toBeCloseTo(0.45, 2);
  });

  it("dominantEmotion derived from Plutchik vector top-1", () => {
    expect(getDominantEmotion([0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.1, 0.1])).toBe("fear");
    expect(getDominantEmotion([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(getDominantEmotion([0.1, 0.1])).toBeNull();
    expect(getDominantEmotion("junk")).toBeNull();
  });

  it("formatEISBlock produces the spec block", () => {
    const ctx: EISContext = {
      agentId: 16, userId: 10,
      pad: { pleasure: 0.45, arousal: 0.2, dominance: 0.1 },
      emotionLabel: "happy",
      trust: 0.9, familiarity: 0.7, interactionCount: 42,
      dominantEmotion: "joy",
    };
    const block = formatEISBlock(ctx);
    expect(block).toContain("[Emotional Context]");
    expect(block).toContain("happy");
    expect(block).toContain("Trust with this user: 90% (42 interactions)");
    expect(block).toContain("Dominant emotion: joy");
  });

  it("EIS_ENABLED=false skips context injection (flag guard, zero storage calls)", async () => {
    expect(eisEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    const out = await maybeAppendEISBlock("BASE PROMPT", 16, 10, {} as NodeJS.ProcessEnv);
    expect(out).toBe("BASE PROMPT");
    expect(__getState).not.toHaveBeenCalled();
  });

  it("EIS_ENABLED=true appends the block when state exists", async () => {
    __getState.mockResolvedValue(dbState());
    __getRel.mockResolvedValue({ trustLevel: 0.5, familiarity: 0.5, interactionCount: 1 });
    const out = await maybeAppendEISBlock("BASE", 16, 10, { EIS_ENABLED: "true" } as any);
    expect(out.startsWith("BASE\n\n[Emotional Context]")).toBe(true);
  });

  it("EIS_ENABLED=true with storage failure falls back to the original prompt", async () => {
    __getState.mockRejectedValue(new Error("db down"));
    const out = await maybeAppendEISBlock("BASE", 16, 10, { EIS_ENABLED: "true" } as any);
    expect(out).toBe("BASE");
  });
});

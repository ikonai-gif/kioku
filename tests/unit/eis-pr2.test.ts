/**
 * [LUCA-092] EIS PR2 -- vitest acceptance (6 cases per spec, with BRO2-A37
 * corrections: cases 4-5 via mocked storage, case 6 as a unit test on
 * maybeAppendEISBlock with the tone flag off).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { __getState, __getRel, __upsert, __poolQuery } = vi.hoisted(() => ({
  __getState: vi.fn(),
  __getRel: vi.fn(),
  __upsert: vi.fn(),
  __poolQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock("../../server/storage", () => ({
  storage: {
    getAgentEmotionalState: __getState,
    getRelationship: __getRel,
    upsertAgentEmotionalState: __upsert,
  },
  pool: { query: __poolQuery },
}));
vi.mock("../../server/logger", () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: l, default: l };
});

import {
  buildEISContext,
  buildToneHint,
  maybeAppendEISBlock,
  eisToneEnabled,
  padToEmotionLabel,
} from "../../server/eis-context";
import { handleEISEvent, EIS_EVENT_DELTAS } from "../../server/eis-events";

const NOW = Date.parse("2026-06-12T07:00:00Z");
const EIS_ON = { EIS_ENABLED: "true" } as unknown as NodeJS.ProcessEnv;

function dbState(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    agentId: 16,
    userId: 10,
    pleasure: 0.5,
    arousal: 0.0,
    dominance: 0.0,
    baselinePleasure: 0.1,
    baselineArousal: 0.0,
    baselineDominance: 0.0,
    emotionLabel: "relaxed",
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
  __upsert.mockReset();
  __poolQuery.mockReset();
  __poolQuery.mockResolvedValue({ rows: [] });
  __upsert.mockImplementation(async (_a: number, _u: number, st: any) => st);
});

describe("EIS PR2 (LUCA-092)", () => {
  // Case 1: decay at 2 half-lives -> ~25% of the delta above baseline
  it("PAD decay at 2 half-lives returns ~25% above baseline (live source)", async () => {
    __getState.mockResolvedValue(
      dbState({ pleasure: 0.5, lastUpdatedAt: NOW - 240 * 60 * 1000 }),
    );
    __getRel.mockResolvedValue({ trustLevel: 0.5, familiarity: 0.5, interactionCount: 1 });
    const ctx = await buildEISContext(16, 10, { now: NOW });
    expect(ctx).not.toBeNull();
    expect(ctx!.pad.pleasure).toBeCloseTo(0.1 + (0.5 - 0.1) * 0.25, 2); // ≈ 0.2
  });

  // Case 2: exuberant octant (A37 corr.1: reuse prod padToEmotionLabel)
  it("padToEmotionLabel returns exuberant for P>0 A>0 D>0", () => {
    expect(padToEmotionLabel(0.3, 0.2, 0.1)).toBe("exuberant");
  });

  // Case 3: baseline intensity -> no tone hint
  it("buildToneHint returns empty string at baseline", () => {
    expect(
      buildToneHint("content", { pleasure: 0.05, arousal: 0.02, dominance: 0.03 }),
    ).toBe("");
  });

  it("buildToneHint emits the tone section above the intensity gate", () => {
    const hint = buildToneHint("exuberant", { pleasure: 0.5, arousal: 0.4, dominance: 0.3 });
    expect(hint).toContain("## EMOTIONAL CONTEXT");
    expect(hint).toContain("exuberant");
  });

  // Case 4: consensus event raises pleasure (mocked storage, no live DB)
  it("deliberation consensus event raises pleasure", async () => {
    __getState.mockResolvedValue(dbState({ pleasure: 0.2 }));
    await handleEISEvent(16, 10, "deliberation_consensus", {}, EIS_ON);
    expect(__upsert).toHaveBeenCalledTimes(1);
    const persisted = __upsert.mock.calls[0][2];
    expect(persisted.pleasure).toBeCloseTo(0.2 + EIS_EVENT_DELTAS.deliberation_consensus.deltaP, 5);
    expect(persisted.pleasure).toBeGreaterThan(0.2);
  });

  // Case 5: rejection event lowers pleasure
  it("user rejection event lowers pleasure", async () => {
    __getState.mockResolvedValue(dbState({ pleasure: 0.2 }));
    await handleEISEvent(16, 10, "user_rejection", {}, EIS_ON);
    const persisted = __upsert.mock.calls[0][2];
    expect(persisted.pleasure).toBeCloseTo(0.2 + EIS_EVENT_DELTAS.user_rejection.deltaP, 5);
    expect(persisted.pleasure).toBeLessThan(0.2);
  });

  it("PAD stays clamped to [-1, 1] after events", async () => {
    __getState.mockResolvedValue(dbState({ pleasure: 0.99, arousal: 0.99, dominance: 0.99 }));
    await handleEISEvent(16, 10, "deliberation_consensus", {}, EIS_ON);
    const persisted = __upsert.mock.calls[0][2];
    expect(persisted.pleasure).toBeLessThanOrEqual(1);
    expect(persisted.arousal).toBeLessThanOrEqual(1);
    expect(persisted.dominance).toBeLessThanOrEqual(1);
  });

  it("EIS_ENABLED off -> handleEISEvent is a no-op with zero storage calls", async () => {
    await handleEISEvent(16, 10, "deliberation_consensus", {}, {} as NodeJS.ProcessEnv);
    expect(__getState).not.toHaveBeenCalled();
    expect(__upsert).not.toHaveBeenCalled();
  });

  // Case 6: EIS_TONE_ENABLED=false -> tone section never injected
  it("EIS_TONE_ENABLED=false -> no EMOTIONAL CONTEXT section in prompt", async () => {
    __getState.mockResolvedValue(dbState({ pleasure: 0.8, arousal: 0.5, dominance: 0.4, lastUpdatedAt: Date.now() }));
    __getRel.mockResolvedValue({ trustLevel: 0.5, familiarity: 0.5, interactionCount: 1 });
    expect(eisToneEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    const out = await maybeAppendEISBlock("BASE", 16, 10, EIS_ON);
    expect(out).toContain("[Emotional Context]"); // PR1 block still present
    expect(out).not.toContain("## EMOTIONAL CONTEXT"); // PR2 tone gated off
  });

  it("EIS_TONE_ENABLED=true -> tone section appended to the EIS block", async () => {
    __getState.mockResolvedValue(dbState({ pleasure: 0.8, arousal: 0.5, dominance: 0.4, lastUpdatedAt: Date.now() }));
    __getRel.mockResolvedValue({ trustLevel: 0.5, familiarity: 0.5, interactionCount: 1 });
    const out = await maybeAppendEISBlock("BASE", 16, 10, {
      EIS_ENABLED: "true",
      EIS_TONE_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);
    expect(out).toContain("[Emotional Context]");
    expect(out).toContain("## EMOTIONAL CONTEXT");
  });
});

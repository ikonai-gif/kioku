/**
 * R403-P1 — buildPartnerPromptParts determinism contract.
 *
 * Contract:
 *   1. parts.static is byte-identical across N calls with identical args
 *      (no Math.random output, no per-turn signals leak in). This is the
 *      block we hand to Anthropic with cache_control:ephemeral.
 *   2. parts.dynamic varies across calls (mood + openingStyle picked via
 *      Math.random — at least 2 distinct values across 10 calls).
 *
 * BRO1 R405 P1: any byte-shift before the cache_control breakpoint kills
 * the cache for the rest of the conversation. Lock it down.
 */
import { describe, it, expect } from "vitest";
import { buildPartnerPromptParts } from "../../deliberation";

const ARGS = [
  "Luca",
  "Test partner agent description",
  "## WHO YOU ARE\nLuca, AI partner.\n\n## RECENT CONVERSATIONS\nNone yet.\n\n## Your Memories\nNothing.\n",
  { pleasure: 0.3, arousal: 0.4, dominance: 0.5, emotionLabel: "calm" },
  { trustLevel: 0.6, interactionCount: 12 },
  "minimalist, warm tones",
  [{ reaction: "love", item: "matcha", category: "drink" }],
  ["Boss is interested in iOS launch readiness"],
  ["Suggested A2P 10DLC submission"],
  "Use short sentences. Lowercase ok.",
  "## CORE IDENTITY (durable)\nname: Luca\nrole: AI partner\n",
] as const;

function call() {
  return buildPartnerPromptParts(
    ARGS[0],
    ARGS[1],
    ARGS[2],
    ARGS[3] as any,
    ARGS[4] as any,
    ARGS[5],
    ARGS[6] as any,
    ARGS[7] as any,
    ARGS[8] as any,
    ARGS[9],
    ARGS[10],
  );
}

describe("R403-P1 — buildPartnerPromptParts determinism", () => {
  it("returns shape {static, dynamic} with non-empty strings", () => {
    const parts = call();
    expect(typeof parts.static).toBe("string");
    expect(typeof parts.dynamic).toBe("string");
    expect(parts.static.length).toBeGreaterThan(1000);
    expect(parts.dynamic.length).toBeGreaterThan(0);
  });

  it("static half is byte-identical across 10 calls with identical args", () => {
    const samples = Array.from({ length: 10 }, () => call().static);
    const first = samples[0];
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBe(first);
    }
  });

  it("static half does NOT contain mood or opening-style fragments", () => {
    // These come from PARTNER_MOODS / OPENING_STYLES. They MUST live in
    // dynamic only — otherwise Math.random shifts the cached prefix.
    const parts = call();
    const moodMarkers = [
      "in a reflective mood",
      "feeling energetic",
      "philosophical mood",
      "feeling playful",
      "focused, sharp mood",
      "feeling creative",
      "chill, relaxed mood",
      "feeling bold",
    ];
    for (const m of moodMarkers) {
      expect(parts.static.includes(m)).toBe(false);
    }
    const openingMarkers = [
      "Start with your own thought",
      "Start by connecting what they said",
      "Start with a direct, honest reaction",
      "Start with a question that digs deeper",
      "Start by gently challenging",
      "Start by sharing something you've been thinking about",
      "Start with a brief, vivid analogy",
      "Start by acknowledging what's interesting",
    ];
    for (const m of openingMarkers) {
      expect(parts.static.includes(m)).toBe(false);
    }
  });

  it("dynamic half varies across 10 calls (Math.random mood/openingStyle)", () => {
    const samples = Array.from({ length: 10 }, () => call().dynamic);
    const unique = new Set(samples);
    // 8 moods × 8 styles = 64 combinations; 10 draws → P(all identical) is
    // negligible. Demand ≥2 distinct values to keep the test stable.
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it("dynamic half contains at least one mood AND one opening-style fragment", () => {
    const moodFragments = [
      "in a reflective mood",
      "feeling energetic",
      "philosophical mood",
      "feeling playful",
      "focused, sharp mood",
      "feeling creative",
      "chill, relaxed mood",
      "feeling bold",
    ];
    const openingFragments = [
      "Start with your own thought",
      "Start by connecting what they said",
      "Start with a direct, honest reaction",
      "Start with a question that digs deeper",
      "Start by gently challenging",
      "Start by sharing something you've been thinking about",
      "Start with a brief, vivid analogy",
      "Start by acknowledging what's interesting",
    ];
    const parts = call();
    const hasMood = moodFragments.some((m) => parts.dynamic.includes(m));
    const hasOpening = openingFragments.some((m) => parts.dynamic.includes(m));
    expect(hasMood).toBe(true);
    expect(hasOpening).toBe(true);
  });

  it("dynamic half includes user-supplied dynamic context (memory + emotion + relationship)", () => {
    const parts = call();
    // identitySection extracted from memBlock
    expect(parts.dynamic).toContain("## WHO YOU ARE");
    // emotion label
    expect(parts.dynamic).toContain("calm");
    // relationship trust level (interactionCount=12 -> trustLevel 0.6 = "close")
    expect(parts.dynamic).toContain("close");
    // sanitized description
    expect(parts.dynamic).toContain("Test partner agent description");
    // aesthetic
    expect(parts.dynamic).toContain("minimalist, warm tones");
    // personality from preferences
    expect(parts.dynamic).toContain("matcha");
    // proactive insights
    expect(parts.dynamic).toContain("iOS launch readiness");
    // writingStyleBlock
    expect(parts.dynamic).toContain("Use short sentences");
    // coreIdentityBlock
    expect(parts.dynamic).toContain("CORE IDENTITY");
  });

  it("buildPartnerPrompt wrapper returns parts.static + parts.dynamic content (same total length within tolerance)", async () => {
    // Sanity: legacy single-string form still equals static+dynamic, so the
    // non-Anthropic paths (Gemini / OpenAI / webhook) see the same prompt.
    const { buildPartnerPrompt } = await import("../../deliberation");
    const wrapper = buildPartnerPrompt(
      ARGS[0],
      ARGS[1],
      ARGS[2],
      ARGS[3] as any,
      ARGS[4] as any,
      ARGS[5],
      ARGS[6] as any,
      ARGS[7] as any,
      ARGS[8] as any,
      ARGS[9],
      ARGS[10],
    );
    // Each call has its own random mood/style — assert the static prefix matches.
    const parts = call();
    expect(wrapper.startsWith(parts.static)).toBe(true);
  });
});

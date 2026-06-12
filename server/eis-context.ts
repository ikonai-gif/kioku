/**
 * [LUCA-090] EIS PR1 -- emotional context for the deliberation prompt.
 *
 * Thin, testable composition layer over the existing emotional machinery
 * (server/emotional-state.ts owns decay + PAD->label; storage owns reads).
 * Everything is gated by EIS_ENABLED (default false) -- PR1 builds and
 * tests the path without changing prod behavior.
 *
 * SPEC NOTE (flagged to LUCA): the spec premise that emotional state
 * never reaches the prompt is partially stale -- partner chat already
 * injects emotionContext/relationship. What is genuinely new here:
 * dominant Plutchik emotion, the [Emotional Context] block format, and
 * pure exported functions with vitest coverage per K17 conditions.
 */
import { storage } from "./storage";
import { getDecayedEmotionalState } from "./emotional-state";
import logger from "./logger";

export interface EISContext {
  agentId: number;
  userId: number;
  pad: { pleasure: number; arousal: number; dominance: number };
  emotionLabel: string;
  trust: number;
  familiarity: number;
  interactionCount: number;
  dominantEmotion: string | null;
}

export function eisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EIS_ENABLED ?? "").trim().toLowerCase() === "true";
}

/**
 * [LUCA-092] EIS PR2 -- tone influence, gated separately from EIS_ENABLED.
 * Default false; never enable on prod without an explicit BOSS GO.
 */
export function eisToneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EIS_TONE_ENABLED ?? "").trim().toLowerCase() === "true";
}

/**
 * [LUCA-092 / BRO2-A37 corr.1] PAD->octant label already exists in prod as
 * padToEmotionLabel (server/emotional-state.ts) -- re-exported here for the
 * EIS surface instead of duplicating the octant map.
 */
export { padToEmotionLabel } from "./emotional-state";

/**
 * [LUCA-092] EIS PR2 -- tone hint for the system prompt.
 * Intensity gate: below 0.1 of normalized PAD magnitude we stay silent.
 * Tone texts are the spec toneMap verbatim; keys cover both the spec octant
 * names and the equivalent prod labels from padToEmotionLabel
 * (dependent=excited, relaxed=serene, docile=content, disdainful=bored --
 * same octants, different naming traditions).
 */
export function buildToneHint(
  dominant: string,
  pad: { pleasure: number; arousal: number; dominance: number },
): string {
  const intensity =
    Math.sqrt(pad.pleasure ** 2 + pad.arousal ** 2 + pad.dominance ** 2) / Math.sqrt(3);
  if (intensity < 0.1) return ""; // baseline -- do not influence tone

  const toneMap: Record<string, string> = {
    exuberant: "You are feeling exuberant — ideas flow freely, tone is energetic and warm.",
    excited: "You are feeling excited — slightly elevated energy, forward-leaning.",
    serene: "You are feeling serene — calm, measured, thoughtful.",
    content: "You are feeling content — stable, unhurried, reliable.",
    hostile: "You are feeling tension — be direct, concise, avoid forced warmth.",
    anxious: "You are feeling uncertainty — acknowledge complexity, don't rush conclusions.",
    bored: "You are in a low-energy state — responses may be more terse.",
    sad: "You are in a low state — focus on clarity over enthusiasm.",
    // prod octant labels (padToEmotionLabel) mapped to the same spec texts:
    dependent: "You are feeling excited — slightly elevated energy, forward-leaning.",
    relaxed: "You are feeling serene — calm, measured, thoughtful.",
    docile: "You are feeling content — stable, unhurried, reliable.",
    disdainful: "You are in a low-energy state — responses may be more terse.",
  };

  const text = toneMap[dominant] ?? "";
  if (!text) return "";
  return `\n## EMOTIONAL CONTEXT\n${text}\n`;
}

/** Half-life decay toward baseline -- spec formula, pure (LUCA-090 part 3). */
export function computePADDecay(
  state: {
    pleasure: number; arousal: number; dominance: number;
    baselinePleasure: number; baselineArousal: number; baselineDominance: number;
    halfLifeMinutes: number;
  },
  elapsedMinutes: number,
): { pleasure: number; arousal: number; dominance: number } {
  const halfLife = state.halfLifeMinutes > 0 ? state.halfLifeMinutes : 120;
  const decayFactor = Math.exp((-Math.LN2 * Math.max(0, elapsedMinutes)) / halfLife);
  return {
    pleasure: state.baselinePleasure + (state.pleasure - state.baselinePleasure) * decayFactor,
    arousal: state.baselineArousal + (state.arousal - state.baselineArousal) * decayFactor,
    dominance: state.baselineDominance + (state.dominance - state.baselineDominance) * decayFactor,
  };
}

/** Plutchik axis order used by memories.emotion_vector (float[8]). */
export const PLUTCHIK_ORDER = [
  "joy", "acceptance", "fear", "surprise",
  "sadness", "disgust", "anger", "anticipation",
] as const;

export function getDominantEmotion(vector: unknown): string | null {
  if (!Array.isArray(vector) || vector.length !== 8) return null;
  let best = -1;
  let bestIdx = -1;
  for (let i = 0; i < 8; i++) {
    const v = Number(vector[i]);
    if (!Number.isFinite(v)) return null;
    if (v > best) { best = v; bestIdx = i; }
  }
  if (bestIdx < 0 || best <= 0) return null;
  return PLUTCHIK_ORDER[bestIdx];
}

export function formatEISBlock(ctx: EISContext): string {
  const lines = [
    "[Emotional Context]",
    `Current state: ${ctx.emotionLabel} (P:${ctx.pad.pleasure.toFixed(2)} A:${ctx.pad.arousal.toFixed(2)} D:${ctx.pad.dominance.toFixed(2)})`,
    `Trust with this user: ${(ctx.trust * 100).toFixed(0)}% (${ctx.interactionCount} interactions)`,
  ];
  if (ctx.dominantEmotion) lines.push(`Dominant emotion: ${ctx.dominantEmotion}`);
  return lines.join("\n");
}

export async function buildEISContext(
  agentId: number,
  userId: number,
  opts?: { emotionVector?: unknown; now?: number },
): Promise<EISContext | null> {
  const state = await storage.getAgentEmotionalState(agentId);
  if (!state) return null;
  const rel = await storage.getRelationship(agentId, userId);
  // Decay computed in memory only -- never written back on read (spec part 3).
  const decayed = getDecayedEmotionalState(state, opts?.now);
  return {
    agentId,
    userId,
    pad: { pleasure: decayed.pleasure, arousal: decayed.arousal, dominance: decayed.dominance },
    emotionLabel: decayed.emotionLabel,
    trust: Number(rel?.trustLevel ?? 0),
    familiarity: Number(rel?.familiarity ?? 0),
    interactionCount: Number(rel?.interactionCount ?? 0),
    dominantEmotion: getDominantEmotion(opts?.emotionVector ?? null),
  };
}

/**
 * Flag-gated prompt augmentation. With EIS_ENABLED unset/false this is a
 * pure pass-through that performs zero storage calls.
 */
export async function maybeAppendEISBlock(
  systemPrompt: string,
  agentId: number,
  userId: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!eisEnabled(env)) return systemPrompt;
  try {
    const ctx = await buildEISContext(agentId, userId);
    if (!ctx) return systemPrompt;
    // [LUCA-092] PR2: tone influence shares this single flagged injection
    // point (BRO2-A37 corr.3) -- zero new touchpoints in routes.
    const toneHint = eisToneEnabled(env)
      ? buildToneHint(ctx.emotionLabel, ctx.pad)
      : "";
    return systemPrompt + "\n\n" + formatEISBlock(ctx) + toneHint;
  } catch (e) {
    logger.warn({ component: "eis", err: String(e) }, "[eis] context build failed (non-fatal)");
    return systemPrompt;
  }
}

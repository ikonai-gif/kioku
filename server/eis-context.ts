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
    return systemPrompt + "\n\n" + formatEISBlock(ctx);
  } catch (e) {
    logger.warn({ component: "eis", err: String(e) }, "[eis] context build failed (non-fatal)");
    return systemPrompt;
  }
}

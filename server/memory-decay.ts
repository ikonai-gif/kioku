/**
 * Asymmetric temporal decay for KIOKU memories.
 * Emotional memories decay slower (half-life ~30 days).
 * Semantic memories decay moderately (half-life ~14 days).
 * Episodic memories decay faster (half-life ~7 days).
 * Procedural memories don't decay (skills persist).
 * Temporal/causal/contextual use default ~14 day half-life.
 *
 * Access reinforces strength (spaced repetition effect).
 */

const HALF_LIFE_DAYS: Record<string, number> = {
  emotional: 30,
  semantic: 14,
  episodic: 7,
  procedural: Infinity,
  temporal: 14,
  causal: 14,
  contextual: 14,
};

export function computeDecayedStrength(
  baseStrength: number,
  type: string,
  createdAt: number,
  lastAccessedAt: number | null,
  accessCount: number,
  now: number = Date.now()
): number {
  const halfLife = HALF_LIFE_DAYS[type] ?? 14;
  if (halfLife === Infinity) return baseStrength;

  const referenceTime = lastAccessedAt || createdAt;
  const daysSinceReference = (now - referenceTime) / (1000 * 60 * 60 * 24);

  // Exponential decay: strength * 0.5^(days/halfLife)
  const decay = Math.pow(0.5, daysSinceReference / halfLife);

  // Access reinforcement: each access adds 10% to effective strength (capped at 2x)
  const reinforcement = Math.min(2.0, 1.0 + accessCount * 0.1);

  return Math.max(0, Math.min(1.0, baseStrength * decay * reinforcement));
}

/**
 * Phase 2: Confidence decay system.
 * Uses explicit decay rate per memory rather than type-based half-life.
 * Formula: currentConfidence = originalConfidence * exp(-decayRate * daysSinceLastReinforcement)
 */
export function computeDecayedConfidence(
  originalConfidence: number,
  decayRate: number,
  lastReinforcedAt: number | null,
  createdAt: number,
  now: number = Date.now()
): number {
  if (decayRate <= 0) return originalConfidence;
  const referenceTime = lastReinforcedAt || createdAt;
  const daysSinceReinforcement = (now - referenceTime) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.min(1.0, originalConfidence * Math.exp(-decayRate * daysSinceReinforcement)));
}

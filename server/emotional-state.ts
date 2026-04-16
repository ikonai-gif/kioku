/**
 * Emotional State Engine — Phase 4a
 * PAD (Pleasure-Arousal-Dominance) vector management with temporal decay
 * and emotion label mapping for agent emotional architecture.
 */

// ── Types ────────────────────────────────────────────────────────────

export interface PADVector {
  pleasure: number;   // [-1.0, 1.0]
  arousal: number;    // [-1.0, 1.0]
  dominance: number;  // [-1.0, 1.0]
}

export interface EmotionalState {
  id: number;
  agentId: number;
  userId: number;
  pleasure: number;
  arousal: number;
  dominance: number;
  baselinePleasure: number;
  baselineArousal: number;
  baselineDominance: number;
  emotionLabel: string;
  poignancySum: number;
  halfLifeMinutes: number;
  lastUpdatedAt: number;
  createdAt: number;
}

// ── PAD Decay ────────────────────────────────────────────────────────

/**
 * Exponential decay toward baseline.
 * After `halfLifeMinutes`, the distance from baseline halves.
 *
 * Formula: current = baseline + (current - baseline) * 2^(-deltaMinutes / halfLife)
 */
export function decayPAD(
  current: number,
  baseline: number,
  halfLifeMinutes: number,
  deltaMinutes: number
): number {
  if (deltaMinutes <= 0) return current;
  if (halfLifeMinutes <= 0) return baseline;
  const decayFactor = Math.pow(2, -deltaMinutes / halfLifeMinutes);
  return baseline + (current - baseline) * decayFactor;
}

/**
 * Apply PAD decay to all three dimensions.
 * Returns a new PAD vector with decayed values.
 */
export function decayPADVector(
  current: PADVector,
  baseline: PADVector,
  halfLifeMinutes: number,
  deltaMinutes: number
): PADVector {
  return {
    pleasure: decayPAD(current.pleasure, baseline.pleasure, halfLifeMinutes, deltaMinutes),
    arousal: decayPAD(current.arousal, baseline.arousal, halfLifeMinutes, deltaMinutes),
    dominance: decayPAD(current.dominance, baseline.dominance, halfLifeMinutes, deltaMinutes),
  };
}

/**
 * Clamp a value to [-1.0, 1.0] range.
 */
export function clampPAD(value: number): number {
  return Math.max(-1.0, Math.min(1.0, value));
}

/**
 * Apply deltas to a PAD vector, clamping results to [-1.0, 1.0].
 */
export function applyPADDeltas(
  current: PADVector,
  deltaP: number,
  deltaA: number,
  deltaD: number
): PADVector {
  return {
    pleasure: clampPAD(current.pleasure + deltaP),
    arousal: clampPAD(current.arousal + deltaA),
    dominance: clampPAD(current.dominance + deltaD),
  };
}

// ── PAD → Emotion Label Mapping ──────────────────────────────────────

/**
 * Map PAD vector to an emotion label using the 8 octants of PAD space.
 * Based on Mehrabian's PAD model (1996) octant mapping.
 *
 * Each octant is defined by the sign of P, A, D:
 *   +P +A +D = exuberant (happy, elated)
 *   +P +A -D = dependent (surprised, hopeful)
 *   +P -A +D = relaxed (calm, content)
 *   +P -A -D = docile (tranquil, gentle)
 *   -P +A +D = hostile (angry, aggressive)
 *   -P +A -D = anxious (fearful, worried)
 *   -P -A +D = disdainful (contemptuous, bored)
 *   -P -A -D = sad (depressed, lonely)
 *
 * Neutral zone: all values within [-0.15, 0.15]
 */
export function padToEmotionLabel(P: number, A: number, D: number): string {
  const THRESHOLD = 0.15;

  // Check for neutral zone
  if (Math.abs(P) < THRESHOLD && Math.abs(A) < THRESHOLD && Math.abs(D) < THRESHOLD) {
    return 'neutral';
  }

  // Determine octant based on sign
  const pPos = P >= 0;
  const aPos = A >= 0;
  const dPos = D >= 0;

  if (pPos && aPos && dPos) return 'exuberant';
  if (pPos && aPos && !dPos) return 'dependent';
  if (pPos && !aPos && dPos) return 'relaxed';
  if (pPos && !aPos && !dPos) return 'docile';
  if (!pPos && aPos && dPos) return 'hostile';
  if (!pPos && aPos && !dPos) return 'anxious';
  if (!pPos && !aPos && dPos) return 'disdainful';
  if (!pPos && !aPos && !dPos) return 'sad';

  return 'neutral'; // fallback (should not reach here)
}

/**
 * Get the current emotional state with decay applied based on elapsed time.
 * Returns the decayed PAD vector and updated emotion label.
 */
export function getDecayedEmotionalState(state: EmotionalState, now?: number): {
  pleasure: number;
  arousal: number;
  dominance: number;
  emotionLabel: string;
} {
  const currentTime = now ?? Date.now();
  const deltaMinutes = (currentTime - state.lastUpdatedAt) / 60000;

  const decayed = decayPADVector(
    { pleasure: state.pleasure, arousal: state.arousal, dominance: state.dominance },
    { pleasure: state.baselinePleasure, arousal: state.baselineArousal, dominance: state.baselineDominance },
    state.halfLifeMinutes,
    deltaMinutes
  );

  const emotionLabel = padToEmotionLabel(decayed.pleasure, decayed.arousal, decayed.dominance);

  return {
    ...decayed,
    emotionLabel,
  };
}

/**
 * Create default emotional state values for a new agent.
 */
export function defaultEmotionalState(): Omit<EmotionalState, 'id' | 'agentId' | 'userId' | 'createdAt' | 'lastUpdatedAt'> {
  return {
    pleasure: 0.0,
    arousal: 0.0,
    dominance: 0.0,
    baselinePleasure: 0.1,
    baselineArousal: 0.0,
    baselineDominance: 0.2,
    emotionLabel: 'neutral',
    poignancySum: 0.0,
    halfLifeMinutes: 120,
  };
}

/**
 * [LUCA-092] EIS PR2 -- event-driven PAD updates.
 *
 * handleEISEvent() applies the spec delta table to the agent's PAD vector,
 * clamps to [-1, 1], recomputes the octant label via the existing
 * padToEmotionLabel (server/emotional-state.ts -- single source of truth),
 * and persists through the existing storage.upsertAgentEmotionalState().
 * The last_event_* audit columns (migrations/0027) are updated best-effort.
 *
 * Flag-gated by EIS_ENABLED (same gate as eis-context.ts). With the flag
 * off this is a no-op with zero storage calls. All failures are non-fatal:
 * an EIS event must never break the calling flow (deliberation, routes).
 *
 * PR2 wires exactly two call sites (deliberation consensus / failure in
 * server/structured-deliberation.ts). The remaining triggers from the spec
 * table (memory, approval gate) land in PR2b after PR3b merges, to avoid
 * conflicting with the storage.ts/createMemory changes living on
 * bro2/rls-pr3b. NOT called from storage.createMemory by design.
 */
import { storage, pool } from "./storage";
import { applyPADDeltas, padToEmotionLabel } from "./emotional-state";
import { eisEnabled, eisAppraisalEnabled } from "./eis-context";
import logger from "./logger";

export type EISEventType =
  | "new_memory_high_importance"
  | "memory_reinforcement"
  | "deliberation_consensus"
  | "deliberation_failed"
  | "user_approval"
  | "user_rejection";

/** Spec delta table ([LUCA-092] part 4), taken verbatim. */
export const EIS_EVENT_DELTAS: Record<
  EISEventType,
  { deltaP: number; deltaA: number; deltaD: number }
> = {
  new_memory_high_importance: { deltaP: 0.05, deltaA: 0.03, deltaD: 0.02 },
  memory_reinforcement: { deltaP: 0.02, deltaA: 0.01, deltaD: 0.01 },
  deliberation_consensus: { deltaP: 0.07, deltaA: 0.05, deltaD: 0.05 },
  deliberation_failed: { deltaP: -0.05, deltaA: 0.08, deltaD: -0.04 },
  user_approval: { deltaP: 0.04, deltaA: -0.01, deltaD: 0.03 },
  user_rejection: { deltaP: -0.03, deltaA: 0.04, deltaD: -0.02 },
};

/**
 * [LUCA-099] EIS PR3 -- OCC appraisal modulation (rule-based v1, no LLM).
 *
 * Modulates the base spec delta by event significance: goal-relevance and
 * expectation-congruence derived from the event payload. Output multiplier
 * is clamped to [0.25, 2.0] so a single appraisal never overwhelms the base
 * table. Returns the multiplier plus the appraisal context (persisted to the
 * last_appraisal_context audit column for observability).
 */
export interface AppraisalResult {
  multiplier: number;
  context: { goalRelevance: number; expectationCongruence: number; significance: number };
}

export function appraise(
  eventType: EISEventType,
  payload: Record<string, unknown> = {},
): AppraisalResult {
  // goal-relevance: how much this event bears on the agent's active goal.
  // Derived from payload.importance (0..1) when present, else event-type prior.
  const importance = typeof payload.importance === "number"
    ? Math.max(0, Math.min(1, payload.importance))
    : null;
  const typePrior: Record<EISEventType, number> = {
    new_memory_high_importance: 0.6,
    memory_reinforcement: 0.3,
    deliberation_consensus: 0.8,
    deliberation_failed: 0.7,
    user_approval: 0.7,
    user_rejection: 0.6,
  };
  const goalRelevance = importance ?? typePrior[eventType] ?? 0.5;

  // expectation-congruence: +1 outcome matched expectation, -1 violated it.
  // payload.expected (boolean) when the caller knows; else neutral 0.
  const expectationCongruence = typeof payload.expected === "boolean"
    ? (payload.expected ? 1 : -1)
    : 0;

  // significance scales the delta: high goal-relevance amplifies, an
  // expectation violation amplifies arousal-laden reactions.
  const significance = goalRelevance * (1 + 0.3 * Math.abs(expectationCongruence));
  const multiplier = Math.max(0.25, Math.min(2.0, 0.5 + significance));

  return {
    multiplier,
    context: { goalRelevance, expectationCongruence, significance },
  };
}

/**
 * Apply one EIS event to the agent's emotional state.
 * Never throws -- logs and returns on any failure.
 */
export async function handleEISEvent(
  agentId: number,
  userId: number,
  eventType: EISEventType,
  payload: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!eisEnabled(env)) return;
  const deltas = EIS_EVENT_DELTAS[eventType];
  if (!deltas) {
    logger.warn({ component: "eis", eventType }, "[eis] unknown event type ignored");
    return;
  }
  try {
    const state = await storage.getAgentEmotionalState(agentId);
    const current = {
      pleasure: Number(state?.pleasure ?? 0),
      arousal: Number(state?.arousal ?? 0),
      dominance: Number(state?.dominance ?? 0),
    };
    const next = applyPADDeltas(current, deltas.deltaP, deltas.deltaA, deltas.deltaD);

    // [LUCA-099] EIS PR3 -- OCC appraisal modulation (flag-gated). Scales the
    // base deltas by event significance before applying. Off by default.
    let appraisalContext: AppraisalResult["context"] | null = null;
    let effective = next;
    if (eisAppraisalEnabled(env)) {
      const appraisal = appraise(eventType, payload);
      appraisalContext = appraisal.context;
      effective = applyPADDeltas(
        current,
        deltas.deltaP * appraisal.multiplier,
        deltas.deltaA * appraisal.multiplier,
        deltas.deltaD * appraisal.multiplier,
      );
    }
    const emotionLabel = padToEmotionLabel(effective.pleasure, effective.arousal, effective.dominance);

    await storage.upsertAgentEmotionalState(agentId, userId, {
      pleasure: effective.pleasure,
      arousal: effective.arousal,
      dominance: effective.dominance,
      emotionLabel,
    });

    // Audit columns (migrations/0027 + 0031) -- best-effort, separate from the
    // upsert so storage.ts stays untouched (PR3b owns that file).
    await pool
      .query(
        `UPDATE agent_emotional_state SET last_event_type = $1, last_event_at = $2, last_appraisal_context = $3 WHERE agent_id = $4`,
        [eventType, Date.now(), appraisalContext ? JSON.stringify(appraisalContext) : null, agentId],
      )
      .catch((e: unknown) => {
        logger.warn(
          { component: "eis", eventType, err: String(e) },
          "[eis] last_event audit update failed (non-fatal)",
        );
      });

    logger.info(
      { component: "eis", eventType, agentId, emotionLabel, payloadKeys: Object.keys(payload) },
      "[eis] event applied",
    );
  } catch (e) {
    logger.warn(
      { component: "eis", eventType, agentId, err: String(e) },
      "[eis] event handling failed (non-fatal)",
    );
  }
}

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
import { eisEnabled } from "./eis-context";
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
    const emotionLabel = padToEmotionLabel(next.pleasure, next.arousal, next.dominance);

    await storage.upsertAgentEmotionalState(agentId, userId, {
      pleasure: next.pleasure,
      arousal: next.arousal,
      dominance: next.dominance,
      emotionLabel,
    });

    // Audit columns (migrations/0027) -- best-effort, separate from the
    // upsert so storage.ts stays untouched (PR3b owns that file).
    await pool
      .query(
        `UPDATE agent_emotional_state SET last_event_type = $1, last_event_at = $2 WHERE agent_id = $3`,
        [eventType, Date.now(), agentId],
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

// Phase 1 (P1) — user_told provenance ingest [BRO4 spec / BRO2 impl].
//
// When BOSS posts a human message, deterministically tag a memory derived from
// it with provenance='user_told' — WITHOUT going through Luca (the LLM path
// forces 'luca_inferred' by the no-self-certify invariant). This module is the
// "ingest layer" referenced in BRO4's spec.
//
// Filter (BRO4): NOT every message becomes a memory (that is flood). Only
// substantive, non-trivial, non-duplicate user statements. Heuristics are
// deterministic and unit-tested; no LLM, no schema change.

const GREETINGS = [
  "привет", "здравствуй", "здравствуйте", "хай", "ку", "ок", "окей", "окей",
  "ага", "угу", "спасибо", "спс", "пасиб", "благодарю", "пока", "до встречи",
  "hi", "hello", "hey", "ok", "okay", "thanks", "thank you", "thx", "yo", "yes",
  "no", "да", "нет", "good morning", "доброе утро", "добрый день", "добрый вечер",
];

/** Trivial greeting / acknowledgement — not memory-worthy. */
export function isGreeting(content: string): boolean {
  const c = content.trim().toLowerCase().replace(/[!.,…?\s]+$/g, "");
  if (c.length === 0) return true;
  return GREETINGS.includes(c);
}

/** Slash/bang command — not a fact statement. */
export function isCommand(content: string): boolean {
  return /^\s*[/!]/.test(content);
}

/**
 * Positive signal: looks like a fact, decision, or names an entity.
 * Deterministic approximation of BRO4's "containsFactOrDecision ||
 * containsNamedEntity" — conservative, no NLP. Phase 1.1 can refine.
 */
export function hasFactOrEntitySignal(content: string): boolean {
  const c = content.trim();
  if (/\d/.test(c)) return true;                       // numbers (dates, ages, counts)
  if (/[A-ZА-ЯЁ][a-zа-яё]{2,}/u.test(c)) return true;  // a capitalized word (proper noun)
  // decision / fact verbs (ru + en), word-boundary-ish
  if (/(реш(ил|ение|или)|договор|важно|никогда|всегда|помни|запомни|правил|decid|alway|never|remember|prefer|rule)/iu.test(c)) return true;
  return false;
}

/**
 * Returns a reason string if the message is NOT eligible for a user_told
 * memory, or null if it IS eligible. Pure + deterministic.
 */
export function userToldIneligibleReason(content: string): string | null {
  const c = (content ?? "").trim();
  if (c.length < 20) return "too_short";
  if (isCommand(c)) return "command";
  if (isGreeting(c)) return "greeting";
  if (!hasFactOrEntitySignal(c)) return "no_fact_or_entity_signal";
  return null;
}

/** Eligible for user_told ingest (before dedup, which is an IO concern). */
export function shouldCreateUserToldMemory(content: string): boolean {
  return userToldIneligibleReason(content) === null;
}

// Defaults for the ingested memory. Provenance is the point of P1; type/namespace
// are conservative (shared canonical bucket) and reviewable by BRO4.
export const USER_TOLD_DEFAULTS = {
  type: "episodic" as const,
  namespace: "_conversation_insights",
  importance: 0.6,
  provenance: "user_told" as const,
};

/** Window for duplicate suppression (BRO4: no dup within 1h). */
export const USER_TOLD_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Orchestrate the ingest: eligibility → dedup → createMemory(user_told).
 * IO is delegated to the injected storage so the heuristics above stay pure.
 * Caller invokes fire-and-forget; this never throws to the caller.
 */
export async function ingestUserToldMemory(
  storage: {
    hasRecentUserToldDuplicate: (userId: number, content: string, sinceMs: number) => Promise<boolean>;
    createMemory: (data: any) => Promise<any>;
  },
  userId: number,
  content: string,
): Promise<{ created: boolean; reason: string }> {
  const reason = userToldIneligibleReason(content);
  if (reason) return { created: false, reason };
  const trimmed = content.trim();
  const dup = await storage.hasRecentUserToldDuplicate(userId, trimmed, USER_TOLD_DEDUP_WINDOW_MS);
  if (dup) return { created: false, reason: "recent_duplicate" };
  await storage.createMemory({
    userId,
    content: trimmed,
    type: USER_TOLD_DEFAULTS.type,
    namespace: USER_TOLD_DEFAULTS.namespace,
    importance: USER_TOLD_DEFAULTS.importance,
    provenance: USER_TOLD_DEFAULTS.provenance,
  });
  return { created: true, reason: "created" };
}

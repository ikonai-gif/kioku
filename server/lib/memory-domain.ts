/**
 * Memory Sprint 2 — Domain classification (R373/R382/R384).
 *
 * Two domains govern conflict-resolution policy:
 *   - "behavioral" — facts about what Luca / the system actually did.
 *     For these, telemetry observations OUTRANK user-told claims, because
 *     the user can be wrong about Luca's behavior and Luca can be wrong
 *     about her own behavior. Hard tool fires win.
 *   - "semantic"   — facts about the world, identity, preferences, etc.
 *     For these, user_told outranks tool_observed which outranks luca_inferred.
 *     This is the default for everything except hard self-telemetry.
 *
 * Per BRO1 R384 plan-review: BEHAVIORAL_NS is intentionally narrow.
 * Reflections / self-improvements / proactive-suggestions / conversation-
 * insights are SEMANTIC — they're "how I think about myself" (knowledge),
 * not "what I did" (telemetry). BOSS-told reflections must be able to
 * outrank Luca's own inferences inside those namespaces, which only the
 * semantic ranking allows.
 *
 * Routing only matters for namespaces that exist; an unknown / null
 * namespace defaults to "semantic". This matches existing behavior for
 * the long tail of free-form remember() calls.
 */

export type MemoryDomain = "semantic" | "behavioral";

/**
 * The strict allow-list of behavioral namespaces.
 * Adding to this set widens "tool_observed beats user_told" — be conservative.
 */
const BEHAVIORAL_NS: ReadonlySet<string> = new Set([
  "_self",       // Luca self-namespace umbrella (used by Sprint 1 v2 honesty layer)
  "_telemetry",  // Future tool-observed dumps; reserved name
]);

/**
 * Classify a memory's domain by namespace.
 *
 * Inputs:
 *   - null / undefined / empty string → "semantic"
 *   - any namespace in BEHAVIORAL_NS → "behavioral"
 *   - all other strings → "semantic"
 */
export function memoryDomain(namespace: string | null | undefined): MemoryDomain {
  if (!namespace) return "semantic";
  return BEHAVIORAL_NS.has(namespace) ? "behavioral" : "semantic";
}

/**
 * Provenance hierarchy weight, conditioned on domain.
 *
 * SEMANTIC (knowledge about world / self / preferences):
 *   user_told > tool_observed > luca_inferred
 *
 * BEHAVIORAL (what actually happened in the system):
 *   tool_observed > user_told > luca_inferred  ← R372 fix
 *
 * Returned weight is in [0, 1]. Used in a 10% additive blend with
 * similarity (65%) and importance (25%) — see storage.searchMemories.
 *
 * Unknown provenance values fall back to luca_inferred weight (0.3).
 */
export function provenanceWeight(
  provenance: string | null | undefined,
  namespace: string | null | undefined
): number {
  const domain = memoryDomain(namespace);
  if (domain === "behavioral") {
    if (provenance === "tool_observed") return 1.0;
    if (provenance === "user_told")     return 0.5;
    return 0.3; // luca_inferred or unknown
  }
  // semantic
  if (provenance === "user_told")     return 1.0;
  if (provenance === "tool_observed") return 0.7;
  return 0.3; // luca_inferred or unknown
}

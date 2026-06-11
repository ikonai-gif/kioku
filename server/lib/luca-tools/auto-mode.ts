/**
 * Auto mode — build order #1 PR1 [BRO2-A11 / LUCA-073, variant A].
 *
 * Variant A semantics (LUCA-073 as amended in chat, BOSS-confirmed):
 *   - LUCA_AUTO_MODE_ENABLED=false (default / unset): TODAY's behavior,
 *     byte-for-byte. READ_ONLY and LOW_STAKES_WRITE pass autonomously as
 *     they already do; HIGH_STAKES_WRITE stays behind the existing
 *     approval gate. Zero blast radius.
 *   - LUCA_AUTO_MODE_ENABLED=true: identical execution flow, but every
 *     autonomous (READ_ONLY / LOW_STAKES_WRITE) call is MARKED
 *     auto_mode=true in luca_audit_log so BOSS can filter the Luca Board
 *     audit view to exactly what Luca did without him.
 *
 * The flag controls VISIBILITY/MARKING, not a new gate. It can never
 * loosen anything: HIGH_STAKES_WRITE and UNKNOWN are never auto-eligible,
 * regardless of env (BOSS HARD RULE — build/merge/deploy/spend/external
 * send always gated; PROTOCOL-003 unchanged).
 *
 * Fail-closed: any error in evaluation returns false (not auto).
 */

export type AutoEligibleClassification = "READ_ONLY" | "LOW_STAKES_WRITE";

const AUTO_ELIGIBLE = new Set<string>(["READ_ONLY", "LOW_STAKES_WRITE"]);

/** True iff the kill-switch env flag is explicitly "true". Default off. */
export function isAutoModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return String(env.LUCA_AUTO_MODE_ENABLED ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

/**
 * True iff this classification may ever be marked autonomous.
 * HIGH_STAKES_WRITE / UNKNOWN / anything else -> false, no exceptions.
 */
export function isAutoEligible(classification: string): boolean {
  return AUTO_ELIGIBLE.has(classification);
}

/**
 * Single chokepoint used by recordLucaAudit: should this call be marked
 * auto_mode=true in the audit row? Marking only — never gates, never
 * skips the existing approval flow.
 */
export function autoModeMarker(
  classification: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return isAutoModeEnabled(env) && isAutoEligible(classification);
  } catch {
    return false;
  }
}

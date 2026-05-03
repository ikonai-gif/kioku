/**
 * Phase 5 PR-B (R-luca-computer-ui) — live_frame takeover state.
 *
 * Boss can take over the agent's live Browserbase preview iframe to
 * intervene during a long-running step. While takeover is active the agent
 * loop yields (sleeps 1s and re-checks) instead of issuing new Stagehand
 * actions, and the iframe `pointerEvents` flips to 'auto' so Boss can
 * click/type directly into the BB session.
 *
 * Per BRO1 R438 + R-convention-security-merge-gate (categories 8 + 6):
 *   • State is in-memory, scoped per `stepId` (the running tool_activity_log row)
 *   • Single-tab lock per stepId via `lockedByConnectionId` so two tabs can't
 *     fight for control. Other tabs get the broadcast and reflect the active
 *     mode but cannot acquire the lock until released or the step ends.
 *   • Lock auto-releases on `clearTakeover(stepId)` (called from the
 *     agent-browser finally block) or when `releaseTakeover` is called by
 *     the holder.
 *   • TTL hard-cap (default 10 min) — if a Boss tab crashes mid-takeover,
 *     the lock auto-expires so the agent can resume on the next yield tick.
 *   • Audit append is the storage layer's job (`appendTakeoverLog`); this
 *     module only owns the live flag.
 *
 * No DB writes — purely volatile. Process restart drops all takeovers,
 * which is the correct behaviour (the BB session is also gone).
 */

export type TakeoverMode = "interactive" | "passive";

export interface TakeoverState {
  stepId: string;
  roomId: number;
  /** The current mode. `passive` = Boss is just looking but hasn't grabbed input yet. */
  mode: TakeoverMode;
  /** WS connection id that currently owns the lock. Other tabs reflect read-only. */
  lockedByConnectionId: string;
  /** User who initiated. Recorded for audit + tab-targeting (other tabs of same user reflect). */
  userId: number;
  /** Wallclock for TTL eviction. */
  acquiredAt: number;
  /** Hard ceiling — if reached the takeover is treated as expired. */
  expiresAt: number;
}

/** Hard ceiling — Boss can hold the lock for at most this long without renewing. */
export const TAKEOVER_TTL_MS = 10 * 60 * 1000;

const _state = new Map<string, TakeoverState>();

/** Acquire or upgrade the takeover lock for a stepId. Returns the new state. */
export function acquireTakeover(args: {
  stepId: string;
  roomId: number;
  userId: number;
  mode: TakeoverMode;
  connectionId: string;
}): { ok: true; state: TakeoverState } | { ok: false; reason: "locked"; current: TakeoverState } {
  const { stepId, roomId, userId, mode, connectionId } = args;
  const now = Date.now();
  const existing = _state.get(stepId);

  // Existing & still alive & owned by another connection → reject.
  if (existing && now < existing.expiresAt && existing.lockedByConnectionId !== connectionId) {
    return { ok: false, reason: "locked", current: existing };
  }

  const next: TakeoverState = {
    stepId,
    roomId,
    mode,
    lockedByConnectionId: connectionId,
    userId,
    acquiredAt: now,
    expiresAt: now + TAKEOVER_TTL_MS,
  };
  _state.set(stepId, next);
  return { ok: true, state: next };
}

/** Release the lock if held by the given connection. No-op otherwise. */
export function releaseTakeover(stepId: string, connectionId: string): TakeoverState | null {
  const cur = _state.get(stepId);
  if (!cur) return null;
  if (cur.lockedByConnectionId !== connectionId) return cur;
  _state.delete(stepId);
  return null;
}

/** Clear regardless of holder — called from agent-browser finally on step end. */
export function clearTakeover(stepId: string): void {
  _state.delete(stepId);
}

/** Probe — used by the agent-browser execute loop to decide whether to yield. */
export function isTakeoverActive(stepId: string): boolean {
  const cur = _state.get(stepId);
  if (!cur) return false;
  if (Date.now() >= cur.expiresAt) {
    // Lazy eviction — TTL expired, treat as cleared.
    _state.delete(stepId);
    return false;
  }
  return cur.mode === "interactive";
}

/** Read the current state for a stepId. Returns null if cleared/expired. */
export function getTakeover(stepId: string): TakeoverState | null {
  const cur = _state.get(stepId);
  if (!cur) return null;
  if (Date.now() >= cur.expiresAt) {
    _state.delete(stepId);
    return null;
  }
  return cur;
}

/** Test-only — drop all in-memory state between vitest runs. */
export function __clearTakeoverStateForTests(): void {
  _state.clear();
}

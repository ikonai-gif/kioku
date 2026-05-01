/**
 * R418 — WebSocket reconnect backoff utility
 *
 * Background:
 *   Both partner-chat.tsx and room-detail.tsx previously reconnected on
 *   `ws.onclose` with a fixed `setTimeout(connect, 3000)`. With no jitter
 *   and no cap, two failure modes happened in production:
 *
 *   1. **Reconnect storm.** When the server briefly flaps (Railway redeploy,
 *      brief network blip), every open client retries at exactly t+3s,
 *      t+6s, t+9s... in lockstep. With many clients this creates a
 *      thundering-herd that re-trips upstream limits.
 *
 *   2. **Polling-amplified ratelimit (R415 root).** Each reconnect cycle
 *      also re-runs route-level useQuery polls, hitting plan caps fast.
 *
 *   Fix: exponential backoff (1s -> 2s -> 4s -> 8s -> 16s -> 30s cap)
 *   with ±20% jitter on every interval. Reset to base on a successful
 *   `onopen`. Same algorithm used by the AWS SDK / Twilio / GitHub
 *   Actions runner — well-trodden territory.
 *
 *   This module exports `nextBackoffMs(attempt)` and `BACKOFF_CONFIG` so
 *   the schedule is unit-testable independently of WebSocket internals.
 */

export const BACKOFF_CONFIG = {
  baseMs: 1000,
  capMs: 30000,
  // Multiplier per failed attempt. 2 = doubling.
  factor: 2,
  // Jitter band, ±fraction. 0.2 = ±20%.
  jitter: 0.2,
} as const;

/**
 * Compute the delay before the (attempt+1)-th reconnect.
 *
 *   attempt = 0 -> first reconnect after first close
 *   attempt = 1 -> second reconnect after second close
 *   ...
 *
 * Output is always within `[baseMs * (1 - jitter), capMs * (1 + jitter)]`.
 */
export function nextBackoffMs(attempt: number, rng: () => number = Math.random): number {
  const { baseMs, capMs, factor, jitter } = BACKOFF_CONFIG;
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const exponential = baseMs * Math.pow(factor, safeAttempt);
  const capped = Math.min(exponential, capMs);
  // Jitter is symmetric: rng() in [0,1) → multiplier in [1-jitter, 1+jitter)
  const jitterMultiplier = 1 - jitter + rng() * 2 * jitter;
  return Math.round(capped * jitterMultiplier);
}

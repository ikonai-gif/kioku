/**
 * KIOKU™ — HTTP error helpers.
 *
 * Centralises the 503 + Retry-After contract triggered by an open circuit
 * breaker (see `server/lib/circuit-breaker.ts`). Before this helper, the
 * contract was hand-rolled in three places — the /deliberate route catch,
 * the /api/demo/chat route catch, and the global Express error middleware —
 * with subtle shape drift between them (demo-chat omitted `reason`, and used
 * a dynamic `Retry-After` derived from `err.retryAfterMs`). `send503` is the
 * single source of truth so the W6 Item 2b contract stays stable.
 */

import type { Response } from "express";

export interface Send503Options {
  /**
   * Value for the `Retry-After` response header (seconds). Defaults to 30 —
   * the cooldown for the shared OpenAI breaker. Also serialised into the
   * body as `retry_after_ms = retryAfterSec * 1000` so clients can read
   * either.
   */
  retryAfterSec?: number;
  /**
   * Machine-readable `reason` field. Defaults to `"upstream_circuit_open"` —
   * the canonical W6 2b string that the deliberate-503 contract tests pin.
   */
  reason?: string;
  /**
   * Extra fields to merge into the JSON body after the defaults. Useful for
   * future diagnostics without re-touching every call site.
   */
  extra?: Record<string, unknown>;
}

/**
 * Emit a 503 Service Unavailable response mapped from an open-breaker /
 * upstream-unavailable condition. Preserves the W6 Item 2b wire contract:
 *
 *   status 503
 *   Retry-After: <seconds>
 *   {
 *     error: "service_unavailable",
 *     reason: <reason>,
 *     retry_after_ms: <seconds * 1000>,
 *     ...extra
 *   }
 *
 * `err` is accepted so callers can pass the caught error without inspecting
 * it; today the message isn't rendered to the client (we don't want to leak
 * upstream errors), but the signature leaves room for structured logging in
 * a follow-up without another migration. If `err` is a `CircuitOpenError`
 * with a `retryAfterMs` field and no explicit `retryAfterSec` was provided,
 * that value takes precedence so dynamic cooldowns (e.g. per-agent) still
 * flow through.
 */
export function send503(
  res: Response,
  err: unknown,
  opts: Send503Options = {},
): Response {
  const errRetryAfterMs =
    err && typeof (err as { retryAfterMs?: unknown }).retryAfterMs === "number"
      ? ((err as { retryAfterMs: number }).retryAfterMs)
      : undefined;
  const retryAfterSec =
    opts.retryAfterSec ??
    (errRetryAfterMs !== undefined ? Math.ceil(errRetryAfterMs / 1000) : 30);
  const reason = opts.reason ?? "upstream_circuit_open";
  const retryAfterMs = retryAfterSec * 1000;

  res.setHeader("Retry-After", String(retryAfterSec));
  return res.status(503).json({
    error: "service_unavailable",
    reason,
    retry_after_ms: retryAfterMs,
    ...(opts.extra ?? {}),
  });
}

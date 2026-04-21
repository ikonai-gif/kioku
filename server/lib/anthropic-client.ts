/**
 * KIOKU™ Shared Anthropic breaker (Variant C).
 *
 * Single process-wide breaker protects every `.messages.create` call site:
 * when Anthropic degrades, the first few sites observe failures, the breaker
 * opens, and subsequent sites fail fast with CircuitOpenError instead of
 * piling up hung requests.
 *
 * Per-agent clients are NOT isolated here — one user's bad key can contribute
 * to tripping the shared breaker. Variant A (W8+) will add per-agent breakers
 * mirroring `openai-per-agent-breaker.ts`; Variant C is the minimum viable
 * shield for beta-open.
 *
 * Usage:
 *
 *   const res = await withAnthropicBreaker(client, c => c.messages.create({...}));
 *
 * The Anthropic client is passed in (the caller already resolves it via
 * getAnthropicClient(agent) — per-agent OR shared key), unlike OpenAI where
 * this module owns the shared client. This matches how deliberation.ts
 * already structures the Claude path.
 */

import type Anthropic from "@anthropic-ai/sdk";
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitBreakerStats,
} from "./circuit-breaker";
import logger from "../logger";

export { CircuitOpenError } from "./circuit-breaker";

/**
 * Failure predicate for Anthropic: 5xx and 529 (overload) count as failures;
 * timeouts and network errors (no status) also count. 4xx (other than 429)
 * are caller errors and do NOT trip the breaker. 429 is treated as a failure
 * because it's indistinguishable from upstream degradation for our purposes.
 */
export function isAnthropicFailure(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown })?.status
    ?? (err as { status?: unknown; statusCode?: unknown })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  return true;
}

// Single process-wide breaker. Claude is slower than GPT, so timeouts are
// generous (60s vs OpenAI's 30s). Threshold of 3 is tighter: Claude calls
// are fewer and more expensive, so we want to fail fast.
const anthropicBreaker = new CircuitBreaker({
  name: "anthropic",
  failureThreshold: 3,
  cooldownMs: 30_000,
  successThreshold: 1,
  timeoutMs: 60_000,
  isFailure: isAnthropicFailure,
  onStateChange: (from, to, reason) => {
    const event =
      to === "OPEN" ? "breaker_open" :
      to === "HALF_OPEN" ? "breaker_half_open" :
      to === "CLOSED" ? "breaker_close" :
      "breaker_state_change";
    logger.warn(
      { component: "anthropic_breaker", event, from, to, reason },
      "[circuit] anthropic breaker state change",
    );
  },
});

/**
 * Execute an Anthropic call behind the shared breaker.
 * Throws `CircuitOpenError` when the circuit is OPEN — callers decide how
 * to degrade (boilerplate reply, 503, cached value, etc.).
 */
export async function withAnthropicBreaker<T>(
  client: Anthropic,
  fn: (client: Anthropic) => Promise<T>,
): Promise<T> {
  return anthropicBreaker.exec(() => fn(client));
}

/** Expose breaker state for `/health/monitor`. */
export function getAnthropicBreakerState(): CircuitBreakerStats {
  return anthropicBreaker.getStats();
}

/** Test-only — resets breaker state. */
export function __resetAnthropicBreakerForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetAnthropicBreakerForTest may only run under NODE_ENV=test");
  }
  anthropicBreaker.reset();
}

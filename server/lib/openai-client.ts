/**
 * KIOKU™ Shared OpenAI client + circuit breaker.
 *
 * Single process-wide breaker protects every hot-path OpenAI call site:
 * when OpenAI degrades, the first few sites observe failures, the breaker
 * opens, and subsequent sites fail fast with CircuitOpenError instead of
 * piling up hung requests.
 *
 * Per-agent OpenAI clients (deliberation.ts:4903) are deliberately NOT
 * routed through this breaker — a single user's bad key must not open the
 * breaker for everyone else. See Week 5 plan F3.
 *
 * Consumers wrap their call site:
 *
 *   const res = await withOpenAIBreaker(client =>
 *     client.chat.completions.create({ ... })
 *   );
 *
 * On CircuitOpenError each caller picks a graceful fallback (null, cached
 * value, 503 to the HTTP layer, etc.).
 */

import OpenAI from "openai";
import {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitBreakerStats,
} from "./circuit-breaker";
import logger from "../logger";

// Re-export so consumers only need to import from this module.
export { CircuitOpenError } from "./circuit-breaker";

// Single process-wide breaker. Thresholds documented in the W5 plan Item 1.
const openaiBreaker = new CircuitBreaker({
  name: "openai",
  failureThreshold: 5,
  cooldownMs: 30_000,
  successThreshold: 2,
  timeoutMs: 30_000,
  isFailure: (err: any) => {
    // 4xx (other than 429) = permanent caller error — don't count as a
    // backend failure. 429, 5xx, network, timeouts all count.
    const status = err?.status ?? err?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
      return false;
    }
    return true;
  },
  onStateChange: (from, to, reason) => {
    logger.warn(
      { component: "circuit:openai", from, to, reason },
      "[circuit] openai breaker state change",
    );
  },
});

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }
  _client = new OpenAI();
  return _client;
}

/**
 * Execute an OpenAI call behind the shared breaker.
 * Throws `CircuitOpenError` when the circuit is OPEN — callers decide
 * how to degrade (null, cached value, 503, etc.).
 */
export async function withOpenAIBreaker<T>(
  fn: (client: OpenAI) => Promise<T>,
): Promise<T> {
  return openaiBreaker.exec(() => fn(getClient()));
}

/** Expose breaker state for `/health/monitor`. */
export function getOpenAIBreakerState(): CircuitBreakerStats {
  return openaiBreaker.getStats();
}

/** Test-only — resets breaker state and lazy client. */
export function __resetOpenAIBreakerForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetOpenAIBreakerForTest may only run under NODE_ENV=test");
  }
  openaiBreaker.reset();
  _client = null;
}

/**
 * Test-only — inject a replacement client (e.g. a stub) so consumers don't
 * have to stub out the OpenAI SDK in every test file.
 */
export function __setOpenAIClientForTest(client: OpenAI | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setOpenAIClientForTest may only run under NODE_ENV=test");
  }
  _client = client;
}

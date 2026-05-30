/**
 * KIOKU™ Shared OpenRouter client + circuit breaker.
 *
 * OpenRouter exposes an OpenAI-compatible Chat Completions API at a custom
 * baseURL, so we reuse the OpenAI SDK pointed at openrouter.ai. This lets the
 * structured-deliberation engine route Claude (anthropic/*), Kimi
 * (moonshotai/*), Llama, DeepSeek, and any other OpenRouter-hosted model as a
 * first-class provider instead of silently falling back to DEFAULT_MODEL.
 *
 * Mirrors openai-client.ts: a single process-wide breaker protects every
 * shared-key OpenRouter call. When OpenRouter degrades, the breaker opens and
 * callers fail fast with CircuitOpenError; callLLM then engages its existing
 * cross-provider fallback (Gemini / OpenAI).
 *
 * Per-agent custom-key isolation is handled separately (see callOpenRouter's
 * customApiKey path) so one tenant's bad key cannot open the shared breaker.
 */

import OpenAI from "openai";
import {
  CircuitBreaker,
  type CircuitBreakerStats,
} from "./circuit-breaker";
import { isOpenAIFailure } from "./openai-client";
import logger from "../logger";

export { CircuitOpenError } from "./circuit-breaker";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://usekioku.com",
  "X-Title": "KIOKU",
};

export const HAS_OPENROUTER_KEY = Boolean(process.env.OPENROUTER_API_KEY);

// Single process-wide breaker — thresholds tuned for OpenRouter specifically.
// timeoutMs is 60s (not 30s like OpenAI breaker) because OpenRouter hosts
// reasoning-models like Kimi K2.6 that consistently spend 30-50s in their
// hidden reasoning chain before emitting visible content. At 30s the breaker
// would mark every Kimi call a timeout-failure (causing LLMAbstainError on
// every turn — verified empirically via PR #167 Variant A pilots #1, #2, #3
// where Ops-Agent abstained or returned empty across all rounds). OpenAI's
// breaker stays at 30s — gpt-4o is non-reasoning and finishes well under it.
const openrouterBreaker = new CircuitBreaker({
  name: "openrouter",
  failureThreshold: 5,
  cooldownMs: 30_000,
  successThreshold: 2,
  timeoutMs: 60_000, // bumped 30s→60s for reasoning-model headroom (Kimi K2.6) [BRO2-317]
  isFailure: isOpenAIFailure, // identical HTTP failure policy (4xx≠429 = caller error)
  onStateChange: (from, to, reason) => {
    logger.warn(
      { component: "circuit:openrouter", from, to, reason },
      "[circuit] openrouter breaker state change",
    );
  },
});

let _sharedClient: OpenAI | null = null;

function getSharedClient(): OpenAI {
  if (_sharedClient) return _sharedClient;
  _sharedClient = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: OPENROUTER_HEADERS,
  });
  return _sharedClient;
}

/** Build a per-agent OpenRouter client (custom key). Not breaker-shared. */
export function makeOpenRouterClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: OPENROUTER_HEADERS,
  });
}

/**
 * Execute an OpenRouter call behind the shared breaker (shared-env-key path).
 * Throws CircuitOpenError when OPEN — caller decides how to degrade.
 */
export async function withOpenRouterBreaker<T>(
  fn: (client: OpenAI) => Promise<T>,
): Promise<T> {
  return openrouterBreaker.exec(() => fn(getSharedClient()));
}

/** Expose breaker state for /health/monitor. */
export function getOpenRouterBreakerState(): CircuitBreakerStats {
  return openrouterBreaker.getStats();
}

/** Test-only — resets breaker state and lazy client. */
export function __resetOpenRouterBreakerForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetOpenRouterBreakerForTest may only run under NODE_ENV=test");
  }
  openrouterBreaker.reset();
  _sharedClient = null;
}

/** Test-only — inject a replacement client (e.g. a stub). */
export function __setOpenRouterClientForTest(client: OpenAI | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setOpenRouterClientForTest may only run under NODE_ENV=test");
  }
  _sharedClient = client;
}

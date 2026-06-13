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

/**
 * [BRO2 overnight P1] Normalize raw model slugs to OpenRouter vendor-prefixed form.
 *
 * Background: some agents in the agents table store provider="openrouter"
 * with llm_model values like "claude-sonnet-4-6", "kimi-k2.6", or "gpt-4o"
 * — bare names without the vendor prefix OpenRouter requires. When these
 * pass through to OpenRouter the API replies 400 model-not-found, the
 * caller's AbortSignal or the breaker fires it as a failure, and the
 * agent falls into abstain on every turn.
 *
 * This helper rewrites known vendor families to their OpenRouter slug.
 * Vendor-prefixed inputs (anthropic/..., moonshotai/..., etc.) pass
 * through untouched. Unknown families return unchanged so OpenRouter
 * errors explicitly instead of being silently rewritten to the wrong
 * model. Also collapses "version-4-6" → "version-4.6" so legacy DB
 * entries that used "-" as the version separator still resolve.
 *
 * Usage: call only when provider === "openrouter". For slug-only
 * (vendor-prefixed) detection paths the input is already valid.
 */
export function normalizeOpenRouterSlug(model: string): string {
  if (/^(moonshotai|anthropic|deepseek|meta-llama|mistralai|qwen|google|x-ai|cohere|openai)\//.test(model)) {
    return model;
  }
  const versionNormalized = model.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  if (/^claude-/i.test(versionNormalized))  return `anthropic/${versionNormalized}`;
  if (/^kimi-/i.test(versionNormalized))    return `moonshotai/${versionNormalized}`;
  if (/^gpt-/i.test(versionNormalized))     return `openai/${versionNormalized}`;
  if (/^gemini-/i.test(versionNormalized))  return `google/${versionNormalized}`;
  if (/^llama/i.test(versionNormalized))    return `meta-llama/${versionNormalized}`;
  if (/^deepseek/i.test(versionNormalized)) return `deepseek/${versionNormalized}`;
  if (/^qwen/i.test(versionNormalized))     return `qwen/${versionNormalized}`;
  if (/^mistral/i.test(versionNormalized))  return `mistralai/${versionNormalized}`;
  return versionNormalized;
}

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
  timeoutMs: 80_000, // [BRO2 overnight P1] 60s→80s — must stay ABOVE structured-deliberation AbortSignal (70s) so caller-side abort fires first, leaving breaker as last-resort. Kimi K2.6 reasoning chain consistently spends 30-50s in hidden chain before emitting visible content; 60s was tight against the 45s AbortSignal regression that this PR also fixes.
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

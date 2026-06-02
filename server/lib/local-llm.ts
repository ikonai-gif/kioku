/**
 * KIOKU™ Local LLM client + circuit breaker.  [patent-room provider — BRO2-320]
 *
 * Ollama (and Hyperspace pods) expose an OpenAI-compatible Chat Completions API
 * at a custom baseURL, so we reuse the OpenAI SDK pointed at LOCAL_LLM_BASE_URL.
 * This is the ONLY provider allowed in patent rooms: when pointed at a locally
 * owned, air-gapped Ollama instance there is no third-party egress.
 *
 * INERT IN PROD BY DESIGN: the base URL comes from env LOCAL_LLM_BASE_URL. On
 * the Railway production instance that env is unset → HAS_LOCAL_LLM is false →
 * callers ABSTAIN. They must NEVER fall back to a cloud provider (esp. patent).
 *
 * Mirrors openrouter-client.ts: a single process-wide breaker protects every
 * local call; CircuitOpenError propagates so callers can abstain.
 */

import OpenAI from "openai";
import {
  CircuitBreaker,
  type CircuitBreakerStats,
} from "./circuit-breaker";
import { isOpenAIFailure } from "./openai-client";
import logger from "../logger";

export { CircuitOpenError } from "./circuit-breaker";

const LOCAL_LLM_BASE_URL = process.env.LOCAL_LLM_BASE_URL || "";
// Sentinel key — Ollama ignores auth, but the OpenAI SDK requires a non-empty key.
const LOCAL_LLM_API_KEY = process.env.LOCAL_LLM_API_KEY || "local";

/** True only when a local endpoint is explicitly configured (unset in prod). */
export const HAS_LOCAL_LLM = Boolean(LOCAL_LLM_BASE_URL);

// Local 7B inference (Ollama on CPU/iMac) can be slow; give generous headroom.
const localBreaker = new CircuitBreaker({
  name: "local-llm",
  failureThreshold: 5,
  cooldownMs: 30_000,
  successThreshold: 2,
  timeoutMs: 120_000,
  isFailure: isOpenAIFailure,
  onStateChange: (from, to, reason) => {
    logger.warn(
      { component: "circuit:local-llm", from, to, reason },
      "[circuit] local-llm breaker state change",
    );
  },
});

let _sharedClient: OpenAI | null = null;

function getSharedClient(): OpenAI {
  if (_sharedClient) return _sharedClient;
  _sharedClient = new OpenAI({
    apiKey: LOCAL_LLM_API_KEY,
    baseURL: LOCAL_LLM_BASE_URL,
  });
  return _sharedClient;
}

/**
 * Execute a local-LLM call behind the shared breaker. Mirrors
 * withOpenRouterBreaker — the HAS_LOCAL_LLM gate is enforced by the caller
 * (callLocal) so the breaker wrapper stays test-injectable.
 */
export async function withLocalBreaker<T>(
  fn: (client: OpenAI) => Promise<T>,
): Promise<T> {
  return localBreaker.exec(() => fn(getSharedClient()));
}

/** Expose breaker state for /health/monitor. */
export function getLocalBreakerState(): CircuitBreakerStats {
  return localBreaker.getStats();
}

/** Test-only — resets breaker state and lazy client. */
export function __resetLocalBreakerForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetLocalBreakerForTest may only run under NODE_ENV=test");
  }
  localBreaker.reset();
  _sharedClient = null;
}

/** Test-only — inject a replacement client (e.g. a stub). */
export function __setLocalClientForTest(client: OpenAI | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setLocalClientForTest may only run under NODE_ENV=test");
  }
  _sharedClient = client;
}

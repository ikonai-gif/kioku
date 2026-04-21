/**
 * KIOKU™ Per-agent OpenAI circuit breaker registry.
 *
 * Custom-key agents (agent.llmApiKey set, provider === "openai") each get
 * their own CircuitBreaker + OpenAI client so that one tenant's bad key or
 * rate-limited account cannot trip the shared process-wide breaker for the
 * rest of the fleet.
 *
 * Shared-key agents (no llmApiKey) are routed through the shared breaker —
 * they run against the same OPENAI_API_KEY and share the fast-fail invariant
 * established in Week 5. (W6 F2: correctness — do NOT create a per-agent
 * breaker for shared-key agents; otherwise a single bad shared call would
 * only trip one agent's breaker instead of protecting the whole process.)
 *
 * Bounded: MAX_AGENTS=1000. Eviction policy is FIFO eviction with non-OPEN
 * preference — we walk Map insertion order and skip OPEN entries so we don't
 * drop live incident data. Pathological fallback (everything OPEN) evicts the
 * true oldest entry. Not true LRU (no touch-on-use).
 */

import OpenAI from "openai";
import { CircuitBreaker } from "./circuit-breaker";
import { withOpenAIBreaker, isOpenAIFailure } from "./openai-client";
import logger from "../logger";

// Module-scoped state. Map insertion order == LRU order for our purposes.
const breakers = new Map<number, CircuitBreaker>();
const clients = new Map<number, OpenAI>();

export const MAX_AGENTS = 1000;

export interface AgentLike {
  id: number;
  llmApiKey?: string | null;
  llmProvider?: string | null;
}

export function isCustomKeyAgent(agent: {
  llmApiKey?: string | null;
  llmProvider?: string | null;
}): boolean {
  return Boolean(agent.llmApiKey) && agent.llmProvider === "openai";
}

function getOrCreateBreaker(agentId: number): CircuitBreaker {
  const existing = breakers.get(agentId);
  if (existing) return existing;

  if (breakers.size >= MAX_AGENTS) {
    // Prefer evicting a non-OPEN entry so live incident data sticks around.
    let evicted = false;
    for (const [key, breaker] of breakers) {
      if (breaker.getStats().state !== "OPEN") {
        breakers.delete(key);
        clients.delete(key);
        evicted = true;
        break;
      }
    }
    if (!evicted) {
      // Pathological: every breaker is OPEN. Evict true oldest so we don't
      // grow unbounded — correctness over observability in this edge case.
      const firstKey = breakers.keys().next().value;
      if (firstKey !== undefined) {
        breakers.delete(firstKey);
        clients.delete(firstKey);
      }
    }
  }

  const breaker = new CircuitBreaker({
    name: `openai:agent:${agentId}`,
    failureThreshold: 5,
    cooldownMs: 30_000,
    successThreshold: 2,
    timeoutMs: 30_000,
    isFailure: isOpenAIFailure,
    onStateChange: (from, to, reason) =>
      logger.warn(
        { component: "openai-per-agent-breaker", agentId, from, to, reason },
        "[breaker] state change",
      ),
  });
  breakers.set(agentId, breaker);
  return breaker;
}

/**
 * Execute an OpenAI call behind the appropriate breaker for the given agent.
 * Shared-key agents delegate to `withOpenAIBreaker` (shared, process-wide).
 * Custom-key agents get an isolated per-agent breaker + per-agent client.
 */
export async function withAgentBreaker<T>(
  agent: AgentLike,
  fn: (client: OpenAI) => Promise<T>,
): Promise<T> {
  if (!isCustomKeyAgent(agent)) {
    return withOpenAIBreaker(fn);
  }

  const breaker = getOrCreateBreaker(agent.id);
  let client = clients.get(agent.id);
  if (!client) {
    client = new OpenAI({ apiKey: agent.llmApiKey! });
    clients.set(agent.id, client);
  }
  return breaker.exec(() => fn(client!));
}

/** Snapshot of every tracked per-agent breaker. Used by admin monitor. */
export function getAllAgentBreakerStates(): Array<{
  agentId: number;
  state: string;
  failures: number;
}> {
  return Array.from(breakers.entries()).map(([id, b]) => {
    const s = b.getStats();
    return { agentId: id, state: s.state, failures: s.consecutiveFailures };
  });
}

/** Aggregate counters for `/health/monitor`. */
export function getAgentBreakerSummary(): { total: number; open: number } {
  let open = 0;
  for (const b of breakers.values()) {
    if (b.getStats().state === "OPEN") open++;
  }
  return { total: breakers.size, open };
}

// ── Test hooks ────────────────────────────────────────────────────────────────

export function __setAgentClientForTest(agentId: number, client: OpenAI): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__setAgentClientForTest may only run under NODE_ENV=test");
  }
  clients.set(agentId, client);
}

export function __resetAllAgentBreakersForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetAllAgentBreakersForTest may only run under NODE_ENV=test");
  }
  breakers.clear();
  clients.clear();
}

/** Test-only introspection — size of the per-agent registry. */
export function __getAgentBreakerMapSizeForTest(): number {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__getAgentBreakerMapSizeForTest may only run under NODE_ENV=test");
  }
  return breakers.size;
}

/** Test-only introspection — set of agent ids currently tracked. */
export function __getTrackedAgentIdsForTest(): number[] {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__getTrackedAgentIdsForTest may only run under NODE_ENV=test");
  }
  return Array.from(breakers.keys());
}

/**
 * Per-(user,agent) sliding-window rate limit for `luca_agent_browser`.
 *
 * Separate counter from `browse-website-guard.ts` — that one is sized for the
 * cheap E2B + Puppeteer path (10/hour, ~$0.05-0.10 per call). `agent_browser`
 * runs on Browserbase managed Chromium with Stagehand multi-step planning at
 * $0.05-0.30 per call. Cap is 5/hour to bound worst-case spend.
 *
 *   5 calls × $0.30 × 24h = $36/day worst case in a hostile loop.
 *
 * Pattern is copy-paste from `server/telegram-inbound.ts:52` per BRO1 R395-Q4
 * to keep the implementation footprint small and grep-able. In-memory Map;
 * resets on server restart — acceptable per BRO1 R366 acceptance and because
 * Browserbase's audit dashboard is the source of truth for true call count.
 *
 * `agentKey` is opaque — caller chooses (typically `${userId}:${agentId}`).
 * Same shape as the browse-website key for observability uniformity.
 */

const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RL_MAX = 5;
const recentCalls: Map<string, number[]> = new Map();

/**
 * Check + record a call for `agentKey`. Returns true when allowed (under
 * cap), false when rate-limited. Caller short-circuits to a tool-result
 * `{status: "rate_limited"}` so the LLM sees a recoverable signal.
 */
export function checkAgentBrowserRateLimit(agentKey: string): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const arr = recentCalls.get(agentKey) ?? [];
  // <=5 entries by definition; in-place prune is cheap.
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= RL_MAX) {
    recentCalls.set(agentKey, fresh);
    return false;
  }
  fresh.push(now);
  recentCalls.set(agentKey, fresh);
  return true;
}

/** Test-only escape hatch — clears the in-memory window so tests don't bleed. */
export function __resetAgentBrowserRateLimitForTests(): void {
  recentCalls.clear();
}

/** Test/debug helper — read current count for a key without recording. */
export function getAgentBrowserRateLimitCount(agentKey: string): number {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const arr = recentCalls.get(agentKey) ?? [];
  return arr.filter((t) => t > cutoff).length;
}

/** Exported constants for tests + observability. */
export const AGENT_BROWSER_RATE_LIMIT = {
  windowMs: RL_WINDOW_MS,
  max: RL_MAX,
} as const;

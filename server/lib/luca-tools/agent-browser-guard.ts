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

// R-luca-browser-open-mode (2026-05-03): default cap raised from 5 to 20
// per hour to give Luca real freedom now that open-internet mode is
// available. Worst-case spend: 20 × $0.30 × 24h = $144/day in a hostile
// loop — still bounded, still grep-able, still resets on restart. Operator
// can override via `LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR` env var without
// shipping code if the budget needs further tuning.
const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
function readRateMax(): number {
  const raw = (process.env.LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR ?? "").trim();
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0 && n <= 200) return n;
  return 20;
}
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
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= readRateMax()) {
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

/** Exported constants for tests + observability. `max` is computed lazily
 * via a getter so env overrides are picked up without process restart in
 * tests. */
export const AGENT_BROWSER_RATE_LIMIT = {
  windowMs: RL_WINDOW_MS,
  get max(): number {
    return readRateMax();
  },
} as const;

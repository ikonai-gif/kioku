/**
 * browse_website input guard + per-agent rate limit.
 *
 * Three layers, in this order (cheapest first):
 *
 *   1. Zod schema validation
 *      - url: string (https://… enforced downstream by validateUrl in
 *        deliberation.ts; here we only require non-empty string)
 *      - action: enum, defaults to "extract_text"
 *      - action="interact" REJECTED at this layer.
 *        Rationale (BRO1 R366 review): interact = side-effects on third-party
 *        servers (form submit, click "delete account", click "buy now").
 *        E2B sandbox isolates network / fs but NOT the remote target. A
 *        prompt-injection-laced page can read luca's instructions and craft
 *        a click that performs a destructive action on Boss's behalf.
 *        Until we have explicit per-domain interact opt-in + approval-gate
 *        wiring, interact is closed.
 *
 *   2. Per-agent rate limit
 *      10 calls / hour / agentId. Browser calls are ~$0.05-0.10 each
 *      (E2B compute + Anthropic vision on screenshot path). 10/hr × $0.10
 *      × 24h = $24/day worst case in a hostile loop — bounded.
 *      Window is in-process Map; resets on server restart, fine for prod
 *      (BRO1 R366 acceptance).
 *
 *   3. (downstream) validateUrl in deliberation.ts dispatch — DNS resolve
 *      + private IP block (incl. 169.254.169.254 metadata, RFC1918,
 *      loopback, link-local). Already in place pre-PR; this guard adds
 *      input shape + rate-limit layers ON TOP of existing SSRF fence.
 */
import { z } from "zod";

// ── Zod schema ──────────────────────────────────────────────────────────────

export const browseWebsiteInputSchema = z.object({
  url: z.string().min(1, "url is required"),
  // Default extract_text (BRO1 R366 "BLOCKER B1 — default" fix).
  // interact REJECTED at validation time (BRO1 R366 "BLOCKER B1 — interact").
  action: z
    .enum(["extract_text", "screenshot", "interact"])
    .default("extract_text")
    .refine(
      (a) => a !== "interact",
      {
        message:
          "browse_website: action='interact' is disabled. interact would let " +
          "a prompt-injected page submit forms / click destructive buttons on " +
          "third-party sites. Use 'extract_text' (DOM after JS render) or " +
          "'screenshot' (visual) instead.",
      },
    ),
  selector: z.string().optional(),
  waitFor: z.string().optional(),
  // instructions accepted but ignored when action !== "interact". Kept in
  // schema so the LLM doesn't see "unknown field" on retries.
  instructions: z.string().optional(),
});

export type BrowseWebsiteValidated = z.infer<typeof browseWebsiteInputSchema>;

export type BrowseWebsiteValidation =
  | { ok: true; value: BrowseWebsiteValidated }
  | { ok: false; reason: string };

/**
 * Validate `browse_website` tool input. Returns a discriminated union so
 * the caller can short-circuit with a tool-result error string instead of
 * throwing through the dispatcher.
 */
export function validateBrowseWebsiteInput(
  input: unknown,
): BrowseWebsiteValidation {
  const parsed = browseWebsiteInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.length ? first.path.join(".") : "input";
    return {
      ok: false,
      reason: `browse_website.input: ${path}: ${first?.message ?? "invalid"}`,
    };
  }
  return { ok: true, value: parsed.data };
}

// ── Per-agent rate limit ────────────────────────────────────────────────────

const RL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RL_MAX = 10;
const recentCalls: Map<string, number[]> = new Map();

/**
 * Check + record a browse_website call for `agentKey`. Returns true if the
 * call is allowed (under cap), false if rate-limited.
 *
 * `agentKey` is opaque — caller chooses (typically `${userId}:${agentId}`).
 * Same key prefix as other Luca rate limits keeps observability uniform.
 */
export function checkBrowseRateLimit(agentKey: string): boolean {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const arr = recentCalls.get(agentKey) ?? [];
  // Window holds <=10 entries by definition; in-place prune is cheap.
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
export function __resetBrowseRateLimitForTests(): void {
  recentCalls.clear();
}

/** Test/debug helper — read current count for a key without recording. */
export function getBrowseRateLimitCount(agentKey: string): number {
  const now = Date.now();
  const cutoff = now - RL_WINDOW_MS;
  const arr = recentCalls.get(agentKey) ?? [];
  return arr.filter((t) => t > cutoff).length;
}

/** Exported constants for tests + observability. */
export const BROWSE_RATE_LIMIT = {
  windowMs: RL_WINDOW_MS,
  max: RL_MAX,
} as const;

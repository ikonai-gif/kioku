/**
 * Per-domain allowlist for `luca_agent_browser`.
 *
 * The agent_browser tool is gated by the LUCA three-level flag stack PLUS a
 * runtime allowlist read from `LUCA_AGENT_BROWSER_ALLOWED_DOMAINS` (CSV).
 * Empty allowlist = tool is effectively disabled even if the per-tool flag
 * is on — defense-in-depth so a flag flip alone can't open a hole.
 *
 * Matching rules (BRO1 R395 P1 — SUFFIX-ONLY wildcards):
 *
 *   `vercel.com` → exact host match (after stripping leading `www.`)
 *
 *   `*.up.railway.app` → matches a STRICT subdomain of `up.railway.app`,
 *     i.e. `kioku-prod.up.railway.app` ✅. Does NOT match the bare base
 *     `up.railway.app` itself — that page is reserved for Railway's
 *     production routing 404 and we don't want to expose it. Does NOT
 *     match `up.railway.app.evil.com` (suffix mismatch).
 *
 *   Wildcards must be the leading label; `foo.*.com` is NOT supported.
 *   The matcher silently treats malformed wildcards as exact strings,
 *   which means they never match anything (safe-fail).
 */

/** Read the raw env value, normalize, and split. */
function readRawAllowlist(): string[] {
  const raw = process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS ?? "";
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/** Lower-case + strip leading `www.` so the rest of the matcher is uniform. */
function cleanHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/**
 * BRO1 R395 P1: SUFFIX-ONLY wildcard match. Pattern `*.suffix` matches a
 * STRICT subdomain (must contain at least one extra label). It does NOT
 * match the base `suffix` itself.
 */
export function domainMatches(host: string, pattern: string): boolean {
  const h = cleanHost(host);
  const p = cleanHost(pattern);
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    if (suffix.length === 0) return false;
    // Strict subdomain — must end in `.suffix`, not just be `suffix`.
    return h.endsWith("." + suffix) && h.length > suffix.length + 1;
  }
  return h === p;
}

/**
 * R-luca-browser-open-mode (2026-05-03): true when the operator has
 * explicitly opted into open-internet mode. Two ways to enable:
 *   1. `LUCA_AGENT_BROWSER_ALLOWED_DOMAINS=*` (single literal asterisk)
 *   2. `LUCA_AGENT_BROWSER_OPEN_MODE=true`
 * Either form opens the door; the blocklist (agent-browser-blocklist.ts)
 * still applies. Empty/missing allowlist still means tool-disabled.
 */
export function isOpenInternetMode(): boolean {
  if ((process.env.LUCA_AGENT_BROWSER_OPEN_MODE ?? "").trim().toLowerCase() === "true") {
    return true;
  }
  const patterns = readRawAllowlist();
  return patterns.length === 1 && patterns[0] === "*";
}

/**
 * Returns true when `host` is permitted by the configured allowlist. An
 * empty allowlist always returns false — see module doc. In open-internet
 * mode, every host is permitted (caller is responsible for blocklist check).
 */
export function isHostAllowed(host: string): boolean {
  if (isOpenInternetMode()) return true;
  const patterns = readRawAllowlist();
  if (patterns.length === 0) return false;
  return patterns.some((p) => domainMatches(host, p));
}

/** Convenience for telemetry / tool-spec embedding. */
export function getAllowedDomainPatterns(): string[] {
  return readRawAllowlist();
}

/** True when no domains are configured — defense-in-depth check.
 * Open-internet mode (`*` or LUCA_AGENT_BROWSER_OPEN_MODE=true) is NOT
 * considered empty: it is a deliberate operator opt-in to allow every host
 * subject to the blocklist. */
export function isAllowlistEmpty(): boolean {
  if (isOpenInternetMode()) return false;
  return readRawAllowlist().length === 0;
}

/**
 * R-luca-browser-open-mode (2026-05-03): hard-coded blocklist for the
 * "open internet" mode. When `LUCA_AGENT_BROWSER_ALLOWED_DOMAINS=*` is set
 * (or `LUCA_AGENT_BROWSER_OPEN_MODE=true`), the per-domain allowlist is
 * bypassed and Luca can visit any public site. This blocklist is the
 * defense-in-depth that survives that bypass: even in open mode, these
 * domains are NEVER reachable.
 *
 * Categories:
 *   - Banking / payments (account compromise risk if creds leak via prompt
 *     injection)
 *   - Cloud provider metadata endpoints (SSRF — internal infra exposure)
 *   - Internal/private network ranges + localhost
 *   - file://, javascript:, data: schemes (handled separately via URL parser)
 *
 * Patterns use the same SUFFIX-ONLY wildcard rules as the allowlist
 * (`*.bank.example` matches strict subdomains only).
 *
 * Match precedence in the handler:
 *   1. blocklist  → ALWAYS deny (highest priority)
 *   2. open mode  → allow if not blocked
 *   3. allowlist  → traditional per-domain allow
 *
 * To add a domain to the block list, add it here, ship a PR, and the
 * change is enforced on next deploy. There's intentionally no env-var
 * override — block decisions are part of the codebase, reviewed in PR.
 */

import { domainMatches } from "./agent-browser-allowlist";

/** Cloud metadata endpoints — SSRF gold targets. */
const METADATA_HOSTS: readonly string[] = [
  "169.254.169.254",       // AWS / GCP / Azure IMDS
  "metadata.google.internal",
  "metadata.azure.com",
  "metadata.aws.internal",
];

/** Banking / payment platforms — credential phishing/exfil risk.
 * Each entry is paired (bare + wildcard) so both `chase.com` and any
 * subdomain (`login.chase.com`) are blocked. */
const FINANCIAL_HOSTS: readonly string[] = [
  "chase.com",          "*.chase.com",
  "bankofamerica.com",  "*.bankofamerica.com",
  "wellsfargo.com",     "*.wellsfargo.com",
  "citi.com",           "*.citi.com",
  "capitalone.com",     "*.capitalone.com",
  "americanexpress.com","*.americanexpress.com",
  "paypal.com",         "*.paypal.com",
  "venmo.com",          "*.venmo.com",
  "cash.app",           "*.cash.app",
  "coinbase.com",       "*.coinbase.com",        // Boss has Coinbase per profile
  "binance.com",        "*.binance.com",
  "kraken.com",         "*.kraken.com",
  "crypto.com",         "*.crypto.com",
  "robinhood.com",      "*.robinhood.com",
  "fidelity.com",       "*.fidelity.com",
  "schwab.com",         "*.schwab.com",
  "vanguard.com",       "*.vanguard.com",
  "tdameritrade.com",   "*.tdameritrade.com",
  "etrade.com",         "*.etrade.com",
  // Stripe is allowed because Boss uses it (server-to-server, not credential
  // login). Adjust here if posture changes.
];

/** Auth providers — session token exfil risk. */
const AUTH_HOSTS: readonly string[] = [
  "okta.com",      "*.okta.com",
  "auth0.com",     "*.auth0.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "duosecurity.com", "*.duosecurity.com",
];

/**
 * Private/internal — should never be reachable from a managed browser.
 *
 * BRO1 R431 hot-fix: extended IPv4 + full IPv6 coverage.
 *
 * IPv4 ranges (in addition to base RFC-1918):
 *   - 127.0.0.0/8       loopback
 *   - 10.0.0.0/8        private
 *   - 192.168.0.0/16    private
 *   - 172.16.0.0/12     private
 *   - 100.64.0.0/10     CGNAT (Tailscale, ngrok, etc.) — BRO1 must-fix
 *   - 169.254.0.0/16    link-local entire range — not just .169.254     — BRO1 must-fix
 *   - 0.0.0.0/8         "this network"
 *
 * IPv6 ranges (BRO1 must-fix — SSRF on cloud-metadata IPv6 is real):
 *   - ::1               loopback
 *   - ::ffff:a.b.c.d    IPv4-mapped — strip wrapper before checking
 *   - fc00::/7          ULA (unique local address)
 *   - fe80::/10         link-local
 *   - fec0::/10         deprecated site-local (kept for safety)
 *   - bracketed-host    [::1] / [fe80::1] forms accepted by URL parser
 */
const INTERNAL_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  // ── IPv4 ranges ──
  /^127(\.\d+){3}$/,                                        // 127.0.0.0/8 loopback
  /^10(\.\d+){3}$/,                                         // 10.0.0.0/8
  /^192\.168(\.\d+){2}$/,                                   // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])(\.\d+){2}$/,                    // 172.16.0.0/12
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.\d+){2}$/,      // 100.64.0.0/10 CGNAT
  /^169\.254(\.\d+){2}$/,                                   // 169.254.0.0/16 link-local (entire)
  /^0(\.\d+){3}$/,                                          // 0.0.0.0/8
  // ── IPv6 ranges (host may be bracketed [::1] or bare ::1) ──
  /^\[?::1\]?$/i,                                            // ::1 loopback
  /^\[?::ffff:[0-9a-f.:]+\]?$/i,                             // IPv4-mapped (defense-in-depth; stripping below also catches it)
  /^\[?f[cd][0-9a-f]{2}:/i,                                  // fc00::/7 ULA
  /^\[?fe[89ab][0-9a-f]:/i,                                  // fe80::/10 link-local
  /^\[?fec[0-9a-f]:/i,                                       // fec0::/10 deprecated site-local
  // ── hostname suffixes ──
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /^kioku-postgres\.railway\.internal$/i,                   // explicit our own
];

/**
 * Strip [...] brackets and IPv4-mapped IPv6 wrapper ("::ffff:1.2.3.4")
 * so the underlying IPv4 string is re-checked against IPv4 regexes.
 * BRO1 R431: prevents an attacker from passing 169.254.169.254 as
 * `[::ffff:169.254.169.254]` to bypass the IPv4-only checks.
 */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  // Strip surrounding brackets used in URL parsing for IPv6 hosts.
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  // IPv4-mapped: ::ffff:1.2.3.4 → 1.2.3.4 (let IPv4 regexes catch it).
  const v4mapped = h.match(/^::ffff:([0-9.]+)$/i);
  if (v4mapped) return v4mapped[1];
  return h;
}

const BLOCKED_DOMAIN_PATTERNS: readonly string[] = [
  ...METADATA_HOSTS,
  ...FINANCIAL_HOSTS,
  ...AUTH_HOSTS,
];

/**
 * Returns true when the host is on the open-mode blocklist (banking,
 * metadata, internal IPs, etc.). Always denied — no env override.
 */
export function isHostBlocked(host: string): boolean {
  if (!host) return true;
  // Normalize: strip brackets, unwrap IPv4-mapped IPv6 so IPv4 regexes catch it.
  const normalized = normalizeHost(host);
  // Internal/private network checks — against BOTH original (for IPv6 forms
  // like ::1, fc00::/7) and normalized (for unwrapped IPv4 inside ::ffff:).
  for (const re of INTERNAL_HOST_PATTERNS) {
    if (re.test(host) || re.test(normalized)) return true;
  }
  // Domain-pattern checks (banking, metadata, auth)
  for (const p of BLOCKED_DOMAIN_PATTERNS) {
    if (domainMatches(normalized, p)) return true;
  }
  return false;
}

/** Telemetry — total number of patterns blocked. */
export function getBlockedDomainCount(): number {
  return BLOCKED_DOMAIN_PATTERNS.length + INTERNAL_HOST_PATTERNS.length;
}

/** Test helper — expose patterns for unit tests. */
export const __BLOCKED_PATTERNS_FOR_TESTS = {
  domains: BLOCKED_DOMAIN_PATTERNS,
  internal: INTERNAL_HOST_PATTERNS,
} as const;

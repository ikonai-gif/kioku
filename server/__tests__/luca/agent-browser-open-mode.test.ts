/**
 * R-luca-browser-open-mode (2026-05-03) — unit tests for the open-internet
 * mode + hard blocklist that lets Luca reach the public web without an
 * exhaustive per-domain allowlist.
 *
 * Coverage:
 *   1. `isOpenInternetMode()` — `LUCA_AGENT_BROWSER_ALLOWED_DOMAINS=*`
 *   2. `isOpenInternetMode()` — `LUCA_AGENT_BROWSER_OPEN_MODE=true`
 *   3. Open mode does NOT count as empty allowlist
 *   4. Blocklist denies banking, cloud-metadata, auth providers
 *   5. Blocklist denies private IP ranges + .local / .internal
 *   6. Blocklist runs even when open mode is on
 *   7. Rate limit override via env var
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isOpenInternetMode,
  isHostAllowed,
  isAllowlistEmpty,
} from "../../lib/luca-tools/agent-browser-allowlist";
import {
  isHostBlocked,
  __BLOCKED_PATTERNS_FOR_TESTS,
} from "../../lib/luca-tools/agent-browser-blocklist";
import { AGENT_BROWSER_RATE_LIMIT } from "../../lib/luca-tools/agent-browser-guard";

const ENV_KEYS = [
  "LUCA_AGENT_BROWSER_ALLOWED_DOMAINS",
  "LUCA_AGENT_BROWSER_OPEN_MODE",
  "LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR",
] as const;

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("agent-browser-allowlist: open-internet mode", () => {
  it("returns false when allowlist is empty and open-mode flag is off", () => {
    expect(isOpenInternetMode()).toBe(false);
  });

  it("recognizes literal '*' as open-mode opt-in", () => {
    process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS = "*";
    expect(isOpenInternetMode()).toBe(true);
    expect(isHostAllowed("example.com")).toBe(true);
    expect(isHostAllowed("any.deep.subdomain.example.org")).toBe(true);
  });

  it("recognizes LUCA_AGENT_BROWSER_OPEN_MODE=true even with a normal allowlist", () => {
    process.env.LUCA_AGENT_BROWSER_OPEN_MODE = "true";
    process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS = "vercel.com";
    expect(isOpenInternetMode()).toBe(true);
    expect(isHostAllowed("not-in-list.example")).toBe(true);
  });

  it("does NOT enable open-mode when allowlist contains '*' alongside other entries", () => {
    process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS = "*,vercel.com";
    expect(isOpenInternetMode()).toBe(false);
    expect(isHostAllowed("example.com")).toBe(false);
  });

  it("open-mode is NOT considered an empty allowlist", () => {
    process.env.LUCA_AGENT_BROWSER_ALLOWED_DOMAINS = "*";
    expect(isAllowlistEmpty()).toBe(false);
  });

  it("empty env still reports empty allowlist", () => {
    expect(isAllowlistEmpty()).toBe(true);
  });
});

describe("agent-browser-blocklist: open-mode safety net", () => {
  it("blocks cloud metadata endpoints (SSRF)", () => {
    expect(isHostBlocked("169.254.169.254")).toBe(true);
    expect(isHostBlocked("metadata.google.internal")).toBe(true);
    expect(isHostBlocked("metadata.azure.com")).toBe(true);
  });

  it("blocks banking / payment platforms", () => {
    expect(isHostBlocked("www.chase.com")).toBe(true);
    expect(isHostBlocked("login.chase.com")).toBe(true);
    expect(isHostBlocked("pay.paypal.com")).toBe(true);
    expect(isHostBlocked("www.coinbase.com")).toBe(true);
    expect(isHostBlocked("api.binance.com")).toBe(true);
    expect(isHostBlocked("vault.fidelity.com")).toBe(true);
  });

  it("blocks auth providers", () => {
    expect(isHostBlocked("accounts.google.com")).toBe(true);
    expect(isHostBlocked("login.microsoftonline.com")).toBe(true);
    expect(isHostBlocked("dev-12345.okta.com")).toBe(true);
  });

  it("blocks private IPv4 ranges", () => {
    expect(isHostBlocked("127.0.0.1")).toBe(true);
    expect(isHostBlocked("10.0.0.5")).toBe(true);
    expect(isHostBlocked("192.168.1.1")).toBe(true);
    expect(isHostBlocked("172.16.0.1")).toBe(true);
    expect(isHostBlocked("172.31.255.255")).toBe(true);
    expect(isHostBlocked("0.0.0.0")).toBe(true);
  });

  it("does NOT block public IP ranges that look numeric", () => {
    expect(isHostBlocked("8.8.8.8")).toBe(false);
    expect(isHostBlocked("172.32.0.1")).toBe(false);   // outside 16-31
    expect(isHostBlocked("172.15.0.1")).toBe(false);
    expect(isHostBlocked("11.0.0.1")).toBe(false);
  });

  it("blocks .local / .internal / .lan suffixes", () => {
    expect(isHostBlocked("printer.local")).toBe(true);
    expect(isHostBlocked("kioku-postgres.railway.internal")).toBe(true);
    expect(isHostBlocked("router.lan")).toBe(true);
    expect(isHostBlocked("localhost")).toBe(true);
  });

  it("does NOT block normal public hosts", () => {
    expect(isHostBlocked("example.com")).toBe(false);
    expect(isHostBlocked("github.com")).toBe(false);
    expect(isHostBlocked("en.wikipedia.org")).toBe(false);
    expect(isHostBlocked("stackoverflow.com")).toBe(false);
  });

  it("treats an empty/undefined host as blocked (defense-in-depth)", () => {
    expect(isHostBlocked("")).toBe(true);
  });

  it("exposes a non-empty pattern set for telemetry", () => {
    expect(__BLOCKED_PATTERNS_FOR_TESTS.domains.length).toBeGreaterThan(10);
    expect(__BLOCKED_PATTERNS_FOR_TESTS.internal.length).toBeGreaterThan(5);
  });
});

describe("agent-browser-guard: configurable rate limit", () => {
  it("defaults to 20/hour", () => {
    expect(AGENT_BROWSER_RATE_LIMIT.max).toBe(20);
  });

  it("respects LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR override", () => {
    process.env.LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR = "60";
    expect(AGENT_BROWSER_RATE_LIMIT.max).toBe(60);
  });

  it("ignores invalid override values (non-numeric, zero, negative, too large)", () => {
    process.env.LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR = "abc";
    expect(AGENT_BROWSER_RATE_LIMIT.max).toBe(20);
    process.env.LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR = "0";
    expect(AGENT_BROWSER_RATE_LIMIT.max).toBe(20);
    process.env.LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR = "-5";
    expect(AGENT_BROWSER_RATE_LIMIT.max).toBe(20);
    process.env.LUCA_AGENT_BROWSER_RATE_MAX_PER_HOUR = "9999";
    expect(AGENT_BROWSER_RATE_LIMIT.max).toBe(20);
  });
});

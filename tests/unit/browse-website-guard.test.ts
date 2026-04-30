import { describe, it, expect, beforeEach } from "vitest";
import {
  validateBrowseWebsiteInput,
  checkBrowseRateLimit,
  __resetBrowseRateLimitForTests,
  getBrowseRateLimitCount,
  BROWSE_RATE_LIMIT,
} from "../../server/lib/luca-tools/browse-website-guard.js";

// BRO1 R366 review fixes — guard for browse_website tool.
//
// 1. zod schema rejects action='interact' (prompt-injection safety) and
//    defaults to extract_text when action omitted.
// 2. per-agent rate-limit 10/hour (browser ~$0.05-0.10 per call).
// 3. per-agent isolation — one agent's spend doesn't burn another's quota.

describe("validateBrowseWebsiteInput — zod input guard", () => {
  it("accepts a minimal valid input and defaults action to extract_text (B1.4)", () => {
    const r = validateBrowseWebsiteInput({ url: "https://example.com" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.url).toBe("https://example.com");
      expect(r.value.action).toBe("extract_text");
    }
  });

  it("accepts action='screenshot' explicitly", () => {
    const r = validateBrowseWebsiteInput({
      url: "https://example.com",
      action: "screenshot",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action).toBe("screenshot");
  });

  it("REJECTS action='interact' (B1 — prompt-injection safety)", () => {
    const r = validateBrowseWebsiteInput({
      url: "https://example.com",
      action: "interact",
      instructions: "click delete account",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.toLowerCase()).toContain("interact");
    }
  });

  it("rejects empty url", () => {
    const r = validateBrowseWebsiteInput({ url: "" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing url", () => {
    const r = validateBrowseWebsiteInput({ action: "extract_text" });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown action values", () => {
    const r = validateBrowseWebsiteInput({
      url: "https://example.com",
      action: "delete_everything",
    });
    expect(r.ok).toBe(false);
  });
});

describe("checkBrowseRateLimit — 10/hour per agent (B1 — rate limit)", () => {
  beforeEach(() => {
    __resetBrowseRateLimitForTests();
  });

  it("exposes the configured limit (10 / 1h)", () => {
    expect(BROWSE_RATE_LIMIT.max).toBe(10);
    expect(BROWSE_RATE_LIMIT.windowMs).toBe(60 * 60 * 1000);
  });

  it("allows the first 10 calls and blocks the 11th for the same agent", () => {
    const key = "u10:luca";
    for (let i = 0; i < 10; i++) {
      expect(checkBrowseRateLimit(key)).toBe(true);
    }
    expect(checkBrowseRateLimit(key)).toBe(false);
    expect(getBrowseRateLimitCount(key)).toBe(10);
  });

  it("isolates rate limits per agentKey (one agent's spend doesn't burn another's)", () => {
    const a = "u10:luca";
    const b = "u10:other-agent";
    for (let i = 0; i < 10; i++) {
      expect(checkBrowseRateLimit(a)).toBe(true);
    }
    // a is now exhausted, b still has full budget
    expect(checkBrowseRateLimit(a)).toBe(false);
    expect(checkBrowseRateLimit(b)).toBe(true);
    expect(getBrowseRateLimitCount(b)).toBe(1);
  });

  it("does not record a slot when the call is blocked", () => {
    const key = "u10:luca";
    for (let i = 0; i < 10; i++) checkBrowseRateLimit(key);
    expect(getBrowseRateLimitCount(key)).toBe(10);
    // Attempt 11 — blocked, count must stay at 10 (not 11).
    expect(checkBrowseRateLimit(key)).toBe(false);
    expect(getBrowseRateLimitCount(key)).toBe(10);
  });
});

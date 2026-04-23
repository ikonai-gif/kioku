/**
 * Unit tests for social-meta.ts. Pure-logic tests — no yt-dlp required.
 */
import { describe, it, expect } from "vitest";
import {
  isSocialHost,
  formatSocialMeta,
  SOCIAL_HOSTS,
  type YtdlpJson,
} from "@/../../server/lib/luca-tools/social-meta";

describe("isSocialHost", () => {
  it("matches bare hosts in the allow list", () => {
    for (const h of SOCIAL_HOSTS) {
      expect(isSocialHost(h)).toBe(true);
    }
  });

  it("matches subdomains (www., m., mobile.)", () => {
    expect(isSocialHost("www.instagram.com")).toBe(true);
    expect(isSocialHost("m.instagram.com")).toBe(true);
    expect(isSocialHost("www.tiktok.com")).toBe(true);
    expect(isSocialHost("mobile.twitter.com")).toBe(true);
    expect(isSocialHost("www.youtube.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSocialHost("WWW.INSTAGRAM.COM")).toBe(true);
    expect(isSocialHost("Instagram.Com")).toBe(true);
  });

  it("rejects non-social hosts", () => {
    expect(isSocialHost("example.com")).toBe(false);
    expect(isSocialHost("news.ycombinator.com")).toBe(false);
    expect(isSocialHost("docs.anthropic.com")).toBe(false);
    expect(isSocialHost("")).toBe(false);
  });

  it("rejects lookalike domains that happen to contain the string", () => {
    // Must be a real subdomain, not a prefix/infix.
    expect(isSocialHost("notinstagram.com")).toBe(false);
    expect(isSocialHost("instagram.com.evil.net")).toBe(false);
    expect(isSocialHost("fakeyoutube.com")).toBe(false);
  });
});

describe("formatSocialMeta", () => {
  it("renders all fields when present", () => {
    const meta: YtdlpJson = {
      title: "Sample reel",
      uploader: "@someone",
      upload_date: "20260418",
      duration: 65,
      view_count: 12345,
      like_count: 678,
      comment_count: 9,
      webpage_url: "https://www.instagram.com/p/ABC/",
      extractor_key: "Instagram",
      description: "Caption body here",
    };
    const out = formatSocialMeta(meta);
    expect(out).toContain("[Social post read via Instagram]");
    expect(out).toContain("Title: Sample reel");
    expect(out).toContain("Author: @someone");
    expect(out).toContain("Posted: 2026-04-18");
    expect(out).toContain("Duration: 1m 05s");
    expect(out).toMatch(/Stats:.*12345 views.*678 likes.*9 comments/);
    expect(out).toContain("URL: https://www.instagram.com/p/ABC/");
    expect(out).toContain("Description / caption:");
    expect(out).toContain("Caption body here");
  });

  it("prefers channel when uploader missing", () => {
    const out = formatSocialMeta({ channel: "ChanName", title: "t" });
    expect(out).toContain("Author: ChanName");
  });

  it("falls back to uploader_id when no uploader/channel", () => {
    const out = formatSocialMeta({ uploader_id: "user_42", title: "t" });
    expect(out).toContain("Author: user_42");
  });

  it("omits missing optional fields (no blank lines)", () => {
    const out = formatSocialMeta({ title: "Only title" });
    expect(out).toContain("Title: Only title");
    expect(out).not.toContain("Author:");
    expect(out).not.toContain("Posted:");
    expect(out).not.toContain("Duration:");
    expect(out).not.toContain("Stats:");
    expect(out).not.toContain("Description");
  });

  it("rejects malformed upload_date", () => {
    const out = formatSocialMeta({ title: "t", upload_date: "2026-04-18" });
    expect(out).not.toContain("Posted:");
    const out2 = formatSocialMeta({ title: "t", upload_date: "bogus" });
    expect(out2).not.toContain("Posted:");
  });

  it("rejects non-positive duration", () => {
    const out = formatSocialMeta({ title: "t", duration: 0 });
    expect(out).not.toContain("Duration:");
    const out2 = formatSocialMeta({ title: "t", duration: -5 });
    expect(out2).not.toContain("Duration:");
  });

  it("truncates long descriptions with a marker", () => {
    const longDesc = "x".repeat(5000);
    const out = formatSocialMeta({ title: "t", description: longDesc });
    expect(out).toContain("[truncated]");
    // Full 5000-char raw body must not appear.
    expect(out.length).toBeLessThan(longDesc.length + 500);
  });

  it("default extractor_key is 'Social post'", () => {
    const out = formatSocialMeta({ title: "t" });
    expect(out).toContain("[Social post read via Social post]");
  });
});

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

// ─── Day 11: retry + classifier tests ───────────────────────────────────

import {
  classifyYtdlpStderr,
  describeSocialFailure,
  formatSocialFailure,
  readSocialMetaDetailed,
  type SocialMetaFailureReason,
} from "@/../../server/lib/luca-tools/social-meta";

describe("classifyYtdlpStderr", () => {
  it("classifies Instagram rate-limit / login-wall", () => {
    expect(
      classifyYtdlpStderr(
        "ERROR: [Instagram] ABC: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser",
      ),
    ).toBe("login_wall");
  });
  it("classifies plain login-required", () => {
    expect(classifyYtdlpStderr("ERROR: login required")).toBe("login_wall");
    expect(classifyYtdlpStderr("Authorization required")).toBe("login_wall");
  });
  it("classifies private posts", () => {
    expect(classifyYtdlpStderr("This video is private")).toBe("private");
  });
  it("classifies not-found / 404", () => {
    expect(classifyYtdlpStderr("HTTP Error 404: not found")).toBe("not_found");
    expect(classifyYtdlpStderr("Video unavailable")).toBe("not_found");
    expect(classifyYtdlpStderr("This post has been removed")).toBe("not_found");
  });
  it("classifies unsupported URLs", () => {
    expect(classifyYtdlpStderr("ERROR: Unsupported URL: https://example.com/foo")).toBe("unsupported");
  });
  it("classifies timeouts", () => {
    expect(classifyYtdlpStderr("socket timed out")).toBe("timeout");
  });
  it("falls back to empty / generic", () => {
    expect(classifyYtdlpStderr("")).toBe("empty");
    expect(classifyYtdlpStderr(undefined)).toBe("empty");
    expect(classifyYtdlpStderr("some unrelated noise")).toBe("generic");
  });
});

describe("describeSocialFailure", () => {
  it("mentions rate-limit / login for login_wall", () => {
    const msg = describeSocialFailure("login_wall", "Instagram");
    expect(msg).toMatch(/rate-limit|login/i);
    expect(msg).toMatch(/Instagram/);
  });
  it("mentions private for private posts", () => {
    expect(describeSocialFailure("private")).toMatch(/private/i);
  });
  it("mentions unavailable for not_found", () => {
    expect(describeSocialFailure("not_found", "TikTok")).toMatch(/unavailable|deleted|removed/i);
  });
});

describe("formatSocialFailure", () => {
  it("includes URL, platform name, and actionable hint", () => {
    const text = formatSocialFailure("https://www.instagram.com/reels/ABC/", "login_wall");
    expect(text).toContain("Instagram");
    expect(text).toContain("https://www.instagram.com/reels/ABC/");
    expect(text).toMatch(/FAILED/);
    expect(text).toMatch(/ask the user/i);
  });
  it("normalizes various social URLs to their platform name", () => {
    expect(formatSocialFailure("https://x.com/user/status/1", "login_wall")).toContain("Twitter/X");
    expect(formatSocialFailure("https://youtu.be/abc", "not_found")).toContain("YouTube");
    expect(formatSocialFailure("https://fb.watch/abc", "generic")).toContain("Facebook");
  });
});

describe("readSocialMetaDetailed", () => {
  it("retries on login_wall with a second UA then surfaces reason", async () => {
    let calls = 0;
    const fakeExec = (async (_bin: string, args: string[]) => {
      calls++;
      // yt-dlp's classic null-on-rate-limit + stderr
      const err: any = new Error("Command failed");
      err.stdout = "null\n";
      err.stderr =
        "ERROR: [Instagram] DXWkRQzAGLf: Requested content is not available, rate-limit reached or login required. Use --cookies-from-browser";
      err.code = 1;
      throw err;
    }) as any;
    const res = await readSocialMetaDetailed("https://www.instagram.com/reels/DXWkRQzAGLf/", {
      execFileFn: fakeExec,
      userAgents: ["ua-a", "ua-b"],
    });
    expect(calls).toBe(2); // retried with the 2nd UA
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("login_wall");
  });

  it("does NOT retry on unsupported/private/not_found (permanent failures)", async () => {
    let calls = 0;
    const fakeExec = (async () => {
      calls++;
      const err: any = new Error("Command failed");
      err.stdout = "";
      err.stderr = "ERROR: Unsupported URL: https://example.com/foo";
      err.code = 1;
      throw err;
    }) as any;
    const res = await readSocialMetaDetailed("https://example.com/foo", {
      execFileFn: fakeExec,
      userAgents: ["ua-a", "ua-b", "ua-c"],
    });
    expect(calls).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("unsupported");
  });

  it("returns formatted success on first-try happy path", async () => {
    const fakeJson = JSON.stringify({
      title: "Test post",
      uploader: "someone",
      description: "hello world",
      extractor_key: "Instagram",
      webpage_url: "https://www.instagram.com/p/XYZ/",
    });
    const fakeExec = (async () => ({ stdout: fakeJson, stderr: "" })) as any;
    const res = await readSocialMetaDetailed("https://www.instagram.com/p/XYZ/", {
      execFileFn: fakeExec,
      userAgents: ["ua-a"],
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("Instagram");
    expect(res.text).toContain("Test post");
    expect(res.text).toContain("hello world");
  });

  it("treats stdout === 'null' as a failure (not a successful parse)", async () => {
    const fakeExec = (async () => ({ stdout: "null\n", stderr: "" })) as any;
    const res = await readSocialMetaDetailed("https://www.instagram.com/p/XYZ/", {
      execFileFn: fakeExec,
      userAgents: ["ua-a"],
    });
    expect(res.ok).toBe(false);
    // empty stderr → classifier returns "empty"
    expect(res.reason).toBe("empty");
  });

  it("respects userAgents list length as retry budget", async () => {
    let calls = 0;
    const fakeExec = (async () => {
      calls++;
      return { stdout: "null", stderr: "ERROR: rate-limit reached" };
    }) as any;
    const res = await readSocialMetaDetailed("https://www.instagram.com/p/Q/", {
      execFileFn: fakeExec,
      userAgents: ["a", "b", "c", "d"],
    });
    expect(calls).toBe(4);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("login_wall");
  });
});

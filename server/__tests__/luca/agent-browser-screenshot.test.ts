/**
 * Phase 2 (R-luca-computer-ui) — agent_browser screenshot persistence tests.
 *
 * Covers BRO1 R431 must-fixes:
 *   1. Private bucket + signed URL TTL = 1h (assert expiresSec passed = 3600)
 *   2. Blocklist-pre-upload — refuses to upload when finalUrl points at
 *      an internal / cloud-metadata host
 *   3. Workspace disabled ⇒ returns null gracefully
 *   4. Empty / malformed inputs ⇒ returns null
 *   5. saveAssetAndSign error ⇒ returns null (best-effort, never throws)
 *   6. Happy path returns PersistedScreenshot with all fields populated
 *   7. toMediaRow round-trip → snake_case JSONB shape
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveAssetAndSignMock = vi.fn();
const workspaceEnabledMock = vi.fn(() => true);

vi.mock("../../workspace-storage", () => ({
  get workspaceEnabled() {
    return workspaceEnabledMock();
  },
  saveAssetAndSign: (...args: any[]) => saveAssetAndSignMock(...args),
  getSignedUrl: vi.fn(),
}));

import {
  persistAgentBrowserScreenshot,
  toMediaRow,
  isUrlSafeForUpload,
} from "../../lib/luca-tools/agent-browser-screenshot";

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAAAA//9k=";

beforeEach(() => {
  saveAssetAndSignMock.mockReset();
  workspaceEnabledMock.mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistAgentBrowserScreenshot — workspace disabled", () => {
  it("returns null and does not call saveAssetAndSign", async () => {
    workspaceEnabledMock.mockReturnValue(false);
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "https://example.com/",
    });
    expect(out).toBeNull();
    expect(saveAssetAndSignMock).not.toHaveBeenCalled();
  });
});

describe("persistAgentBrowserScreenshot — empty / malformed inputs", () => {
  it("returns null on empty b64", async () => {
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: "",
      finalUrl: "https://example.com/",
    });
    expect(out).toBeNull();
    expect(saveAssetAndSignMock).not.toHaveBeenCalled();
  });

  it("returns null on whitespace-only b64", async () => {
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      // Buffer.from("   ", "base64") -> length 0
      screenshotB64: "   ",
      finalUrl: "https://example.com/",
    });
    expect(out).toBeNull();
  });
});

describe("persistAgentBrowserScreenshot — blocklist-pre-upload (BRO1 R431 must-fix #2)", () => {
  it("refuses upload when finalUrl points at AWS IMDS (link-local)", async () => {
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "http://169.254.169.254/latest/meta-data/",
    });
    expect(out).toBeNull();
    expect(saveAssetAndSignMock).not.toHaveBeenCalled();
  });

  it("refuses upload when finalUrl points at IPv6 loopback", async () => {
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "http://[::1]:8080/",
    });
    expect(out).toBeNull();
    expect(saveAssetAndSignMock).not.toHaveBeenCalled();
  });

  it("refuses upload when finalUrl is malformed", async () => {
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "not-a-url",
    });
    expect(out).toBeNull();
    expect(saveAssetAndSignMock).not.toHaveBeenCalled();
  });

  it("refuses upload when finalUrl points at CGNAT 100.64/10", async () => {
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "http://100.64.0.1/",
    });
    expect(out).toBeNull();
    expect(saveAssetAndSignMock).not.toHaveBeenCalled();
  });

  it("allows upload when finalUrl is null (no host to leak)", async () => {
    saveAssetAndSignMock.mockResolvedValue({ key: "10/16/agent_browser/x.jpg", url: "https://signed.example/x" });
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: null,
    });
    expect(out).not.toBeNull();
    expect(saveAssetAndSignMock).toHaveBeenCalledTimes(1);
  });
});

describe("persistAgentBrowserScreenshot — happy path", () => {
  it("uploads and returns PersistedScreenshot with TTL=1h (BRO1 R431 must-fix #1)", async () => {
    saveAssetAndSignMock.mockResolvedValue({
      key: "10/16/agent_browser/x.jpg",
      url: "https://signed.example/x?token=abc",
    });
    const before = Date.now();
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess-12345",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "https://vercel.com/dashboard",
    });
    const after = Date.now();

    expect(out).not.toBeNull();
    expect(out!.storageKey).toBe("10/16/agent_browser/x.jpg");
    expect(out!.signedUrl).toBe("https://signed.example/x?token=abc");
    expect(out!.contentType).toBe("image/jpeg");
    expect(out!.kind).toBe("screenshot");
    expect(out!.sourceUrl).toBe("https://vercel.com/dashboard");
    // TTL 1 hour ± a few ms
    expect(out!.signedExpiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(out!.signedExpiresAt).toBeLessThanOrEqual(after + 3600 * 1000);

    // Must have asked for 1h expiry, content-type image/jpeg, into agent_browser/ subpath
    expect(saveAssetAndSignMock).toHaveBeenCalledTimes(1);
    const [userId, agentId, relPath, body, opts] = saveAssetAndSignMock.mock.calls[0];
    expect(userId).toBe(10);
    expect(agentId).toBe(16);
    expect(relPath.startsWith("agent_browser/")).toBe(true);
    expect(relPath.endsWith(".jpg")).toBe(true);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).length).toBeGreaterThan(0);
    expect(opts.expiresSec).toBe(3600);
    expect(opts.contentType).toBe("image/jpeg");
  });

  it("sanitizes sessionId in path (no slashes / unicode)", async () => {
    saveAssetAndSignMock.mockResolvedValue({ key: "k", url: "u" });
    await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "../../bad/path?evil=1",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: null,
    });
    const [, , relPath] = saveAssetAndSignMock.mock.calls[0];
    expect(relPath).not.toMatch(/\.\./);
    expect(relPath).not.toMatch(/\?/);
    // The full path is `agent_browser/<ts>_<safe>.jpg` — only one slash allowed (the prefix).
    expect(relPath.startsWith("agent_browser/")).toBe(true);
    const safePart = relPath.replace(/^agent_browser\//, "").replace(/\.jpg$/, "");
    expect(safePart).not.toContain("/");
    expect(safePart).not.toContain("?");
    expect(safePart).not.toContain("..");
  });
});

describe("persistAgentBrowserScreenshot — best-effort error handling", () => {
  it("returns null when saveAssetAndSign rejects (does not throw)", async () => {
    saveAssetAndSignMock.mockRejectedValue(new Error("supabase 503"));
    const out = await persistAgentBrowserScreenshot({
      userId: 10,
      agentId: 16,
      sessionId: "sess",
      screenshotB64: TINY_JPEG_B64,
      finalUrl: "https://github.com/",
    });
    expect(out).toBeNull();
  });
});

describe("isUrlSafeForUpload", () => {
  it("returns true for public URLs", () => {
    expect(isUrlSafeForUpload("https://github.com/foo")).toBe(true);
    expect(isUrlSafeForUpload("https://www.vercel.com/")).toBe(true);
  });

  it("returns false for blocked hosts", () => {
    expect(isUrlSafeForUpload("http://169.254.169.254/")).toBe(false);
    expect(isUrlSafeForUpload("http://localhost/")).toBe(false);
    expect(isUrlSafeForUpload("http://10.0.0.1/")).toBe(false);
    expect(isUrlSafeForUpload("http://192.168.1.1/")).toBe(false);
    expect(isUrlSafeForUpload("http://[::1]/")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isUrlSafeForUpload("not-a-url")).toBe(false);
    expect(isUrlSafeForUpload("javascript:alert(1)")).toBe(false);
  });

  it("returns true for null/undefined (no host to leak)", () => {
    expect(isUrlSafeForUpload(null)).toBe(true);
    expect(isUrlSafeForUpload(undefined)).toBe(true);
    expect(isUrlSafeForUpload("")).toBe(true);
  });
});

describe("toMediaRow", () => {
  it("converts PersistedScreenshot to snake_case JSONB row format", () => {
    const row = toMediaRow({
      storageKey: "10/16/agent_browser/x.jpg",
      signedUrl: "https://signed.example/x",
      signedExpiresAt: 1234567890,
      contentType: "image/jpeg",
      kind: "screenshot",
      sourceUrl: "https://example.com",
    });
    expect(row).toEqual({
      storage_key: "10/16/agent_browser/x.jpg",
      signed_url: "https://signed.example/x",
      signed_expires_at: 1234567890,
      content_type: "image/jpeg",
      kind: "screenshot",
      source_url: "https://example.com",
    });
  });
});

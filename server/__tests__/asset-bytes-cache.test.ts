/**
 * PR-A.6 — server/lib/asset-bytes-cache.ts unit tests.
 *
 * Covers:
 *   - LRU eviction when total bytes would exceed 50 MB budget
 *   - refreshSignedUrlIfNeeded skips refresh when URL has >5 min remaining
 *   - refreshSignedUrlIfNeeded re-issues + patches JSONB when expiry < 5 min away
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockWorkspace = vi.hoisted(() => ({
  getSignedUrl: vi.fn(),
}));
vi.mock("../workspace-storage", () => mockWorkspace);

const mockStorage = vi.hoisted(() => ({
  storage: {
    patchAttachment: vi.fn(),
  },
}));
vi.mock("../storage", () => mockStorage);

import {
  getAssetBytes,
  refreshSignedUrlIfNeeded,
  __resetForTests,
  __getCacheStateForTests,
} from "../lib/asset-bytes-cache";
import type { AttachmentMeta } from "@shared/schema";

const realFetch = global.fetch;

function makeFetchResponse(buf: Buffer, mime = "image/jpeg") {
  return {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? mime : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  } as any;
}

describe("asset-bytes-cache", () => {
  beforeEach(() => {
    __resetForTests();
    mockWorkspace.getSignedUrl.mockReset();
    mockStorage.storage.patchAttachment.mockReset();
  });

  it("evicts oldest entries when adding bytes would exceed 50MB budget", async () => {
    // Two 30MB blobs + one 30MB blob = 90MB total, budget=50MB.
    // After 1st insert: cache holds k1 (30MB).
    // After 2nd insert: must evict k1 to fit k2 (30MB).
    // After 3rd insert: must evict k2 to fit k3 (30MB).
    const big = Buffer.alloc(30 * 1024 * 1024, 0xab);

    mockWorkspace.getSignedUrl.mockResolvedValue("https://signed.example/x");
    const fetchSpy = vi.fn().mockImplementation(async () => makeFetchResponse(big));
    global.fetch = fetchSpy as any;

    await getAssetBytes("k1");
    expect(__getCacheStateForTests().entries).toBe(1);

    await getAssetBytes("k2");
    expect(__getCacheStateForTests().entries).toBe(1);
    expect(__getCacheStateForTests().totalBytes).toBe(30 * 1024 * 1024);

    await getAssetBytes("k3");
    expect(__getCacheStateForTests().entries).toBe(1);

    // k1 should have been evicted; refetch causes a new network call.
    fetchSpy.mockClear();
    await getAssetBytes("k1");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    global.fetch = realFetch;
  });

  it("refreshSignedUrlIfNeeded returns existing url when expiry >5min away", async () => {
    const att: AttachmentMeta = {
      id: "att1",
      kind: "image",
      mime: "image/jpeg",
      size_bytes: 1024,
      storage_key: "k1",
      signed_url: "https://still-fresh.example/x",
      signed_url_expires_at: Date.now() + 60 * 60 * 1000, // 1h ahead
      original_filename: "a.jpg",
      summary_status: "ready",
      summary_text: null,
    } as any;

    const url = await refreshSignedUrlIfNeeded(42, "att1", att);
    expect(url).toBe("https://still-fresh.example/x");
    expect(mockWorkspace.getSignedUrl).not.toHaveBeenCalled();
    expect(mockStorage.storage.patchAttachment).not.toHaveBeenCalled();
  });

  it("refreshSignedUrlIfNeeded re-issues + patches back when <5min remain", async () => {
    const att: AttachmentMeta = {
      id: "att1",
      kind: "image",
      mime: "image/jpeg",
      size_bytes: 1024,
      storage_key: "k1",
      signed_url: "https://stale.example/x",
      signed_url_expires_at: Date.now() + 30 * 1000, // 30s ahead — needs refresh
      original_filename: "a.jpg",
      summary_status: "ready",
      summary_text: null,
    } as any;

    mockWorkspace.getSignedUrl.mockResolvedValue("https://fresh.example/x");
    mockStorage.storage.patchAttachment.mockResolvedValue(undefined);

    const url = await refreshSignedUrlIfNeeded(42, "att1", att);
    expect(url).toBe("https://fresh.example/x");
    expect(mockWorkspace.getSignedUrl).toHaveBeenCalledWith("k1", 3600);
    expect(mockStorage.storage.patchAttachment).toHaveBeenCalledTimes(1);
    const [msgId, attId, patch] = mockStorage.storage.patchAttachment.mock.calls[0];
    expect(msgId).toBe(42);
    expect(attId).toBe("att1");
    expect(patch.signed_url).toBe("https://fresh.example/x");
    expect(typeof patch.signed_url_expires_at).toBe("number");
    expect(patch.signed_url_expires_at).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  });
});

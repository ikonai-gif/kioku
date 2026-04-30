/**
 * PR-A.6 — server/lib/multimodal-history.ts unit tests.
 *
 * Covers:
 *   - supportsVision whitelist (sonnet 4 / 3.5 yes; claude-2 / claude-instant no)
 *   - awaitSummaryIfPending no-op fast path when nothing pending
 *   - awaitSummaryIfPending refresh-loop happy path (summary lands on first poll)
 *   - buildMultimodalClaudeMessages text fallback when image fetch fails
 *   - buildTextHistoryWithAttachments inlines [image: ...] / [voice ...] / [file ...]
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage", () => ({
  storage: {
    getRoomMessagesByIds: vi.fn(),
  },
}));

vi.mock("../lib/asset-bytes-cache", () => ({
  getAssetBytes: vi.fn(),
  refreshSignedUrlIfNeeded: vi.fn().mockResolvedValue(null),
}));

import {
  supportsVision,
  awaitSummaryIfPending,
  buildMultimodalClaudeMessages,
  buildTextHistoryWithAttachments,
} from "../lib/multimodal-history";
import { storage } from "../storage";
import { getAssetBytes } from "../lib/asset-bytes-cache";

function msg(overrides: any = {}): any {
  return {
    id: 1,
    roomId: 1,
    agentId: null,
    agentName: "Котэ",
    agentColor: "#C9A340",
    content: "hi",
    isDecision: false,
    attachments: [],
    searchText: null,
    createdAt: 1000,
    ...overrides,
  };
}

function attach(overrides: any = {}): any {
  return {
    id: "att_1",
    type: "image",
    mime: "image/jpeg",
    size_bytes: 1234,
    storage_key: "u10/a16/test.jpg",
    signed_url: "https://supabase/x",
    signed_url_expires_at: Date.now() + 3_600_000,
    summary: null,
    transcription: null,
    extracted_text: null,
    duration_sec: null,
    original_name: "test.jpg",
    uploaded_at: Date.now(),
    expires_at: null,
    ...overrides,
  };
}

describe("multimodal-history · supportsVision", () => {
  it("accepts modern Claude SKUs", () => {
    expect(supportsVision("claude-sonnet-4-6")).toBe(true);
    expect(supportsVision("claude-3-5-sonnet-20241022")).toBe(true);
    expect(supportsVision("claude-3-haiku")).toBe(true);
  });
  it("rejects legacy Claude (no vision) and non-Claude inputs", () => {
    expect(supportsVision("claude-2.1")).toBe(false);
    expect(supportsVision("claude-instant-1")).toBe(false);
    expect(supportsVision("gpt-4.1-mini")).toBe(false);
    expect(supportsVision(null)).toBe(false);
    expect(supportsVision(undefined)).toBe(false);
  });
});

describe("multimodal-history · awaitSummaryIfPending", () => {
  beforeEach(() => {
    (storage.getRoomMessagesByIds as any).mockReset();
  });

  it("returns immediately when nothing is pending", async () => {
    const messages = [msg({ attachments: [attach({ summary: "ok" })] })];
    const result = await awaitSummaryIfPending(messages);
    expect(result).toBe(messages);
    expect(storage.getRoomMessagesByIds).not.toHaveBeenCalled();
  });

  it("polls and returns updated message when summary lands", async () => {
    const m = msg({ id: 42, attachments: [attach({ summary: null })] });
    const refreshed = msg({
      id: 42,
      attachments: [attach({ summary: "Котёнок на подоконнике" })],
    });
    (storage.getRoomMessagesByIds as any).mockResolvedValue([refreshed]);
    const result = await awaitSummaryIfPending([m]);
    expect(result[0].attachments[0].summary).toBe("Котёнок на подоконнике");
  });
});

describe("multimodal-history · buildMultimodalClaudeMessages", () => {
  beforeEach(() => {
    (getAssetBytes as any).mockReset();
  });

  it("falls back to [image: summary] when bytes can't be fetched", async () => {
    (getAssetBytes as any).mockResolvedValue(null);
    const m = msg({
      content: "look at this",
      attachments: [attach({ summary: "Котёнок" })],
    });
    const out = await buildMultimodalClaudeMessages([m], {
      modelId: "claude-sonnet-4-6",
      agentId: 16,
      isPartnerChat: true,
    });
    expect(out).toHaveLength(1);
    const blocks = out[0].content as any[];
    expect(Array.isArray(blocks)).toBe(true);
    const fallback = blocks.find((b) => b.type === "text" && b.text.includes("[image"));
    expect(fallback?.text).toContain("Котёнок");
  });
});

describe("multimodal-history · buildTextHistoryWithAttachments", () => {
  it("inlines [image: ...] / [voice ...] / [file ...] fallbacks", () => {
    const m1 = msg({
      id: 1,
      content: "hello",
      attachments: [attach({ summary: "Кот в окне" })],
    });
    const m2 = msg({
      id: 2,
      content: "",
      attachments: [
        attach({ id: "att_v", type: "voice", mime: "audio/ogg", duration_sec: 12, transcription: "Привет" }),
      ],
    });
    const m3 = msg({
      id: 3,
      content: "see file",
      attachments: [
        attach({
          id: "att_f",
          type: "file",
          mime: "application/pdf",
          original_name: "spec.pdf",
          extracted_text: "Section 1: Goals",
        }),
      ],
    });
    const result = buildTextHistoryWithAttachments([m1, m2, m3], {
      agentId: 16,
      isPartnerChat: true,
    });
    expect(result[0].content).toContain("[image: Кот в окне]");
    expect(result[1].content).toContain("[voice 12s: Привет]");
    expect(result[2].content).toContain("[file spec.pdf:");
    expect(result[2].content).toContain("Section 1: Goals");
  });

  it("falls back to plain content when no attachments", () => {
    const m = msg({ content: "just text" });
    const out = buildTextHistoryWithAttachments([m], {
      agentId: 16,
      isPartnerChat: true,
    });
    expect(out[0].content).toBe("just text");
  });
});

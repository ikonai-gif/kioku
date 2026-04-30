/**
 * PR-A.6 — server/lib/attachment-summarizer.ts unit tests.
 *
 * Covers:
 *   - concurrency cap MAX_PARALLEL=3 (4th call must wait until one finishes)
 *   - voice path: Whisper mock returns text, summary truncated to 100 chars
 *   - file path: PDF extraction via pdf-parse mock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mocks ────────────────────────────────────────────────────────────────────

const mockStorage = vi.hoisted(() => ({
  storage: {
    getAttachment: vi.fn(),
    patchAttachment: vi.fn(),
    updateMessageSearchText: vi.fn(),
  },
}));
vi.mock("../storage", () => mockStorage);

const mockBytesCache = vi.hoisted(() => ({
  getAssetBytes: vi.fn(),
}));
vi.mock("../lib/asset-bytes-cache", () => mockBytesCache);

// Anthropic + OpenAI clients are constructed lazily inside the module via
// `new Anthropic({apiKey})` / `new OpenAI({apiKey})`. We mock the SDK modules
// to return controllable client instances.
const mockAnthropic = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockAnthropic.messagesCreate };
  },
}));

const mockOpenAI = vi.hoisted(() => ({
  transcribe: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    audio = { transcriptions: { create: mockOpenAI.transcribe } };
  },
}));

// pdf-parse is dynamically imported as a string spec — vitest's vi.mock can't
// reliably hook a runtime-string-import. Instead we rely on the fact that the
// summarizer falls back to "[file] name" when import or parse throws, and we
// inject a global hook for the test PDF case.
const mockPdfParse = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("pdf-parse", () => ({ default: mockPdfParse.fn }));

// Ensure ENV vars exist so getAnthropic()/getOpenAI() return clients.
process.env.ANTHROPIC_API_KEY = "test-anth";
process.env.OPENAI_API_KEY = "test-oai";

import {
  summarizeAttachment,
  __getQueueStateForTests,
  __waitForIdleForTests,
} from "../lib/attachment-summarizer";

function fakeAtt(overrides: Partial<any> = {}): any {
  return {
    id: "att_x",
    type: "image",
    mime: "image/jpeg",
    size_bytes: 1024,
    storage_key: "k",
    signed_url: null,
    signed_url_expires_at: 0,
    summary: null,
    transcription: null,
    extracted_text: null,
    duration_sec: null,
    original_name: "a.jpg",
    uploaded_at: Date.now(),
    expires_at: null,
    ...overrides,
  };
}

describe("attachment-summarizer", () => {
  beforeEach(() => {
    mockStorage.storage.getAttachment.mockReset();
    mockStorage.storage.patchAttachment.mockReset();
    mockStorage.storage.updateMessageSearchText.mockReset();
    mockBytesCache.getAssetBytes.mockReset();
    mockAnthropic.messagesCreate.mockReset();
    mockOpenAI.transcribe.mockReset();
    mockPdfParse.fn.mockReset();
  });

  afterEach(async () => {
    await __waitForIdleForTests();
  });

  it("respects MAX_PARALLEL=3 — 4th call queues until one finishes", async () => {
    // Each summarize gates on a manual promise so we can observe queue state.
    const gates: Array<{ resolve: () => void }> = [];
    const makeGated = () =>
      new Promise<any>((resolve) => {
        gates.push({ resolve: () => resolve({ content: [{ type: "text", text: "ok" }] }) });
      });

    mockStorage.storage.getAttachment.mockResolvedValue(fakeAtt());
    mockBytesCache.getAssetBytes.mockResolvedValue({
      mime: "image/jpeg",
      data: Buffer.from([0x00]),
    });
    mockStorage.storage.patchAttachment.mockResolvedValue(undefined);
    mockStorage.storage.updateMessageSearchText.mockResolvedValue(undefined);
    mockAnthropic.messagesCreate.mockImplementation(makeGated);

    const p1 = summarizeAttachment(1, "att1");
    const p2 = summarizeAttachment(2, "att2");
    const p3 = summarizeAttachment(3, "att3");
    const p4 = summarizeAttachment(4, "att4");

    // Let microtasks settle so all 4 enter the limiter.
    await new Promise((r) => setTimeout(r, 20));

    const s = __getQueueStateForTests();
    expect(s.active).toBe(3);
    expect(s.queued).toBe(1);

    // Drain in order.
    gates[0].resolve();
    await p1;
    await new Promise((r) => setTimeout(r, 10));
    // After one finishes, the 4th should be active (queued back to 0).
    expect(__getQueueStateForTests().queued).toBe(0);
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await Promise.all([p2, p3, p4]);
  });

  it("voice: transcribes via Whisper, summary truncated to 100 chars", async () => {
    const longText = "А".repeat(150);
    mockStorage.storage.getAttachment.mockResolvedValue(
      fakeAtt({ id: "att_v", type: "voice", mime: "audio/ogg", original_name: "v.ogg", duration_sec: 12 }),
    );
    mockBytesCache.getAssetBytes.mockResolvedValue({
      mime: "audio/ogg",
      data: Buffer.from([0x4f, 0x67, 0x67, 0x53]),
    });
    mockOpenAI.transcribe.mockResolvedValue({ text: longText });
    mockStorage.storage.patchAttachment.mockResolvedValue(undefined);
    mockStorage.storage.updateMessageSearchText.mockResolvedValue(undefined);

    await summarizeAttachment(7, "att_v");

    expect(mockOpenAI.transcribe).toHaveBeenCalledTimes(1);
    expect(mockStorage.storage.patchAttachment).toHaveBeenCalledTimes(1);
    const [msgId, attId, patch] = mockStorage.storage.patchAttachment.mock.calls[0];
    expect(msgId).toBe(7);
    expect(attId).toBe("att_v");
    expect(patch.transcription).toBe(longText);
    expect(patch.summary.length).toBeLessThanOrEqual(101); // 100 chars + ellipsis
    expect(patch.summary.endsWith("…")).toBe(true);
    expect(mockStorage.storage.updateMessageSearchText).toHaveBeenCalledWith(7);
  });

  it("file (pdf): extracts text via pdf-parse and uses head as summary", async () => {
    const fullText = "Это длинный PDF про продакт-менеджмент. ".repeat(20);
    mockStorage.storage.getAttachment.mockResolvedValue(
      fakeAtt({
        id: "att_p",
        type: "file",
        mime: "application/pdf",
        original_name: "doc.pdf",
      }),
    );
    mockBytesCache.getAssetBytes.mockResolvedValue({
      mime: "application/pdf",
      data: Buffer.from([0x25, 0x50, 0x44, 0x46]),
    });
    mockPdfParse.fn.mockResolvedValue({ text: fullText });
    mockStorage.storage.patchAttachment.mockResolvedValue(undefined);
    mockStorage.storage.updateMessageSearchText.mockResolvedValue(undefined);

    await summarizeAttachment(11, "att_p");

    expect(mockPdfParse.fn).toHaveBeenCalledTimes(1);
    const [, , patch] = mockStorage.storage.patchAttachment.mock.calls[0];
    expect(patch.extracted_text).toBe(fullText.trim());
    // Summary is first 200 chars + ellipsis.
    expect(patch.summary.length).toBeLessThanOrEqual(201);
    expect(patch.summary.startsWith("Это длинный PDF")).toBe(true);
  });
});

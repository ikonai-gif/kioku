/**
 * [LUCA-060] MarkItDown extraction — unit tests (no real CLI; runner injected).
 * Covers candidate detection, guard rails (non-candidate / empty / oversize),
 * success path, failure→null fallback, and the output length cap.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../server/logger", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { extractViaMarkItDown, isMarkItDownCandidate } = await import(
  "../../server/lib/markitdown"
);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const small = Buffer.from("PK\u0003\u0004 fake office bytes");

describe("isMarkItDownCandidate", () => {
  it("accepts office mime types", () => {
    expect(isMarkItDownCandidate("report", DOCX)).toBe(true);
  });
  it("accepts by extension even with octet-stream mime", () => {
    expect(isMarkItDownCandidate("report.xlsx", "application/octet-stream")).toBe(true);
    expect(isMarkItDownCandidate("deck.pptx", "application/octet-stream")).toBe(true);
  });
  it("rejects pdf and plain text (handled by other paths)", () => {
    expect(isMarkItDownCandidate("doc.pdf", "application/pdf")).toBe(false);
    expect(isMarkItDownCandidate("notes.txt", "text/plain")).toBe(false);
  });
  it("rejects images", () => {
    expect(isMarkItDownCandidate("photo.png", "image/png")).toBe(false);
  });
});

describe("extractViaMarkItDown", () => {
  it("returns trimmed CLI output for a candidate", async () => {
    const runner = vi.fn().mockResolvedValue("\n# Title\n\nHello from docx\n");
    const out = await extractViaMarkItDown(small, "report.docx", DOCX, runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(out).toBe("# Title\n\nHello from docx");
  });

  it("returns null and never spawns for a non-candidate", async () => {
    const runner = vi.fn();
    const out = await extractViaMarkItDown(Buffer.from("hi"), "notes.txt", "text/plain", runner);
    expect(out).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns null and never spawns for an empty buffer", async () => {
    const runner = vi.fn();
    const out = await extractViaMarkItDown(Buffer.alloc(0), "report.docx", DOCX, runner);
    expect(out).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns null and never spawns for oversize files (>15MB)", async () => {
    const runner = vi.fn();
    const big = Buffer.alloc(16 * 1024 * 1024, 1);
    const out = await extractViaMarkItDown(big, "huge.docx", DOCX, runner);
    expect(out).toBeNull();
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns null when the CLI throws (fallback path)", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("python3: command not found"));
    const out = await extractViaMarkItDown(small, "report.docx", DOCX, runner);
    expect(out).toBeNull();
  });

  it("caps very long output at 200k chars", async () => {
    const runner = vi.fn().mockResolvedValue("x".repeat(300_000));
    const out = await extractViaMarkItDown(small, "report.docx", DOCX, runner);
    expect(out?.length).toBe(200_000);
  });
});

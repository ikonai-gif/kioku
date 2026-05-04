/**
 * Phase 6 PR-B — unit tests for ActivityTimeline variant routing &
 * live_frame promotion logic.
 */

import { describe, expect, it } from "vitest";
import {
  resolveActivityVariant,
  selectActiveLiveFrame,
  type ActiveLiveFrameInput,
} from "../../client/src/lib/activity-timeline-variant";

describe("resolveActivityVariant", () => {
  it("returns 'sidebar' when prop is explicitly sidebar regardless of mode", () => {
    expect(resolveActivityVariant("sidebar", "computer")).toBe("sidebar");
    expect(resolveActivityVariant("sidebar", "chat")).toBe("sidebar");
    expect(resolveActivityVariant("sidebar", null)).toBe("sidebar");
  });

  it("returns 'canvas' when prop is explicitly canvas regardless of mode", () => {
    expect(resolveActivityVariant("canvas", "chat")).toBe("canvas");
    expect(resolveActivityVariant("canvas", "computer")).toBe("canvas");
    expect(resolveActivityVariant("canvas", undefined)).toBe("canvas");
  });

  it("auto + computer mode → canvas", () => {
    expect(resolveActivityVariant("auto", "computer")).toBe("canvas");
  });

  it("auto + chat mode → sidebar", () => {
    expect(resolveActivityVariant("auto", "chat")).toBe("sidebar");
  });

  it("default prop (undefined) → auto behaviour", () => {
    expect(resolveActivityVariant(undefined, "computer")).toBe("canvas");
    expect(resolveActivityVariant(undefined, "chat")).toBe("sidebar");
  });

  it("auto + null/undefined canvas mode → sidebar (defensive)", () => {
    expect(resolveActivityVariant("auto", null)).toBe("sidebar");
    expect(resolveActivityVariant("auto", undefined)).toBe("sidebar");
  });
});

describe("selectActiveLiveFrame", () => {
  function row(
    stepId: string,
    status: string,
    startedAt: number,
    media?: ActiveLiveFrameInput["mediaUrls"],
  ): ActiveLiveFrameInput {
    return { stepId, status, startedAt, mediaUrls: media };
  }

  it("returns null on empty input", () => {
    expect(selectActiveLiveFrame([])).toBeNull();
  });

  it("returns null when no rows have live_frame media", () => {
    const rows = [
      row("s1", "running", 100, [
        { kind: "screenshot", signedUrl: "https://x/a.png" },
      ]),
      row("s2", "running", 200, [
        { kind: "file", signedUrl: "https://x/b.pdf" },
      ]),
    ];
    expect(selectActiveLiveFrame(rows)).toBeNull();
  });

  it("ignores live_frame on done/error rows (BB session torn down)", () => {
    const rows = [
      row("s1", "done", 200, [
        { kind: "live_frame", signedUrl: "https://bb/old", sourceUrl: "https://bb/old/replay" },
      ]),
      row("s2", "error", 300, [
        { kind: "live_frame", signedUrl: "https://bb/err" },
      ]),
    ];
    expect(selectActiveLiveFrame(rows)).toBeNull();
  });

  it("picks the only running live_frame", () => {
    const rows = [
      row("s1", "done", 100),
      row("s2", "running", 200, [
        { kind: "live_frame", signedUrl: "https://bb/live", sourceUrl: "https://bb/replay" },
      ]),
    ];
    const m = selectActiveLiveFrame(rows);
    expect(m).not.toBeNull();
    expect(m!.stepId).toBe("s2");
    expect(m!.signedUrl).toBe("https://bb/live");
    expect(m!.sourceUrl).toBe("https://bb/replay");
    expect(m!.startedAt).toBe(200);
  });

  it("prefers the most recent running live_frame when multiple exist", () => {
    const rows = [
      row("s-old", "running", 100, [
        { kind: "live_frame", signedUrl: "https://bb/old" },
      ]),
      row("s-new", "running", 500, [
        { kind: "live_frame", signedUrl: "https://bb/new" },
      ]),
      row("s-mid", "running", 300, [
        { kind: "live_frame", signedUrl: "https://bb/mid" },
      ]),
    ];
    const m = selectActiveLiveFrame(rows);
    expect(m!.stepId).toBe("s-new");
  });

  it("normalises missing sourceUrl to null", () => {
    const rows = [
      row("s1", "running", 100, [
        { kind: "live_frame", signedUrl: "https://bb/x" },
      ]),
    ];
    const m = selectActiveLiveFrame(rows);
    expect(m!.sourceUrl).toBeNull();
  });

  it("returns the last row when startedAt ties (matches append order)", () => {
    const rows = [
      row("s-first", "running", 100, [
        { kind: "live_frame", signedUrl: "https://bb/1" },
      ]),
      row("s-second", "running", 100, [
        { kind: "live_frame", signedUrl: "https://bb/2" },
      ]),
    ];
    const m = selectActiveLiveFrame(rows);
    expect(m!.stepId).toBe("s-second");
  });

  it("ignores rows where mediaUrls is undefined entirely", () => {
    const rows = [
      row("s1", "running", 100, undefined),
      row("s2", "running", 200, [
        { kind: "live_frame", signedUrl: "https://bb/ok" },
      ]),
    ];
    const m = selectActiveLiveFrame(rows);
    expect(m!.stepId).toBe("s2");
  });
});

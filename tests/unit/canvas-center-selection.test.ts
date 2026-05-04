/**
 * Phase 6 PR-D (R-luca-computer-ui hot-fix) — pure-logic tests for
 * `selectActiveLiveFrame` exercised through the lens of the new
 * CanvasCenter pipeline (BRO1 R450 Q-D1).
 *
 * No React, no WS — vitest default `node` env.
 */

import { describe, expect, it } from "vitest";
import { selectActiveLiveFrame } from "@/lib/activity-timeline-variant";

interface Row {
  stepId: string;
  status: string;
  startedAt: number;
  mediaUrls?: ReadonlyArray<{ kind: string; signedUrl: string; sourceUrl?: string | null }>;
}

const liveFrame = (url: string, src: string | null = null) => ({
  kind: "live_frame",
  signedUrl: url,
  sourceUrl: src,
});

describe("CanvasCenter active live_frame selector", () => {
  it("returns null for empty rows", () => {
    expect(selectActiveLiveFrame([])).toBeNull();
  });

  it("returns null when no row has status=running", () => {
    const rows: Row[] = [
      { stepId: "a", status: "done", startedAt: 100, mediaUrls: [liveFrame("u1")] },
      { stepId: "b", status: "error", startedAt: 200, mediaUrls: [liveFrame("u2")] },
    ];
    expect(selectActiveLiveFrame(rows)).toBeNull();
  });

  it("returns the live_frame for a single running row", () => {
    const rows: Row[] = [
      { stepId: "running-step", status: "running", startedAt: 1000, mediaUrls: [liveFrame("u-live", "https://target.example/page")] },
    ];
    const match = selectActiveLiveFrame(rows);
    expect(match).not.toBeNull();
    expect(match?.stepId).toBe("running-step");
    expect(match?.signedUrl).toBe("u-live");
    expect(match?.sourceUrl).toBe("https://target.example/page");
  });

  it("returns the most-recently-started running row when multiple qualify", () => {
    const rows: Row[] = [
      { stepId: "older", status: "running", startedAt: 1000, mediaUrls: [liveFrame("u-old")] },
      { stepId: "newer", status: "running", startedAt: 5000, mediaUrls: [liveFrame("u-new")] },
      { stepId: "middle", status: "running", startedAt: 3000, mediaUrls: [liveFrame("u-mid")] },
    ];
    expect(selectActiveLiveFrame(rows)?.stepId).toBe("newer");
  });

  it("ignores done step's live_frame even with valid signedUrl (server torn down)", () => {
    const rows: Row[] = [
      { stepId: "done-step", status: "done", startedAt: 9_999, mediaUrls: [liveFrame("u-stale")] },
    ];
    expect(selectActiveLiveFrame(rows)).toBeNull();
  });

  it("returns null when row has running status but no live_frame media", () => {
    const rows: Row[] = [
      { stepId: "step", status: "running", startedAt: 1000, mediaUrls: [{ kind: "screenshot", signedUrl: "s1" }] },
    ];
    expect(selectActiveLiveFrame(rows)).toBeNull();
  });

  it("does not throw on rows missing mediaUrls (malformed payload)", () => {
    const rows: Row[] = [
      { stepId: "broken", status: "running", startedAt: 100 },
    ];
    expect(() => selectActiveLiveFrame(rows)).not.toThrow();
    expect(selectActiveLiveFrame(rows)).toBeNull();
  });

  it("ties on startedAt resolve to the latest in input order", () => {
    const rows: Row[] = [
      { stepId: "first",  status: "running", startedAt: 5000, mediaUrls: [liveFrame("u1")] },
      { stepId: "second", status: "running", startedAt: 5000, mediaUrls: [liveFrame("u2")] },
    ];
    const match = selectActiveLiveFrame(rows);
    expect(match?.stepId).toBe("second");
    expect(match?.signedUrl).toBe("u2");
  });

  it("sourceUrl falls back to null when the media omits it", () => {
    const rows: Row[] = [
      { stepId: "step", status: "running", startedAt: 100, mediaUrls: [{ kind: "live_frame", signedUrl: "u" }] },
    ];
    expect(selectActiveLiveFrame(rows)?.sourceUrl).toBeNull();
  });
});

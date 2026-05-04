/**
 * Phase 6 PR-D (R-luca-computer-ui hot-fix) — extends activity-timeline-variant
 * tests with the new "canvas-with-host" variant + helper predicates.
 *
 * BRO1 R450 N2 — `canvas-with-host` MUST resolve to `canvas-with-host` (not
 * collapse to `canvas`) and `shouldMountTimelineHero` must return false for
 * it so the host page (CanvasCenter) owns the iframe exclusively.
 */

import { describe, expect, it } from "vitest";

import {
  isCanvasResolvedVariant,
  resolveActivityVariant,
  shouldMountTimelineHero,
} from "@/lib/activity-timeline-variant";

describe("ActivityTimeline variant — PR-D canvas-with-host", () => {
  it("explicit canvas-with-host stays canvas-with-host regardless of mode", () => {
    expect(resolveActivityVariant("canvas-with-host", "computer")).toBe("canvas-with-host");
    expect(resolveActivityVariant("canvas-with-host", "chat")).toBe("canvas-with-host");
    expect(resolveActivityVariant("canvas-with-host", null)).toBe("canvas-with-host");
  });

  it("auto + computer mode still resolves to canvas (legacy default)", () => {
    expect(resolveActivityVariant("auto", "computer")).toBe("canvas");
  });

  it("auto + chat mode still resolves to sidebar", () => {
    expect(resolveActivityVariant("auto", "chat")).toBe("sidebar");
  });

  it("isCanvasResolvedVariant covers both canvas and canvas-with-host", () => {
    expect(isCanvasResolvedVariant("canvas")).toBe(true);
    expect(isCanvasResolvedVariant("canvas-with-host")).toBe(true);
    expect(isCanvasResolvedVariant("sidebar")).toBe(false);
  });

  it("shouldMountTimelineHero is true ONLY for standalone canvas (BRO1 N2)", () => {
    // Standalone canvas (no host CanvasCenter) → ActivityTimeline owns the hero.
    expect(shouldMountTimelineHero("canvas")).toBe(true);
    // canvas-with-host → host owns the hero, timeline must not mount one.
    expect(shouldMountTimelineHero("canvas-with-host")).toBe(false);
    // Sidebar → no hero.
    expect(shouldMountTimelineHero("sidebar")).toBe(false);
  });
});

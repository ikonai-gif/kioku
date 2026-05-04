/**
 * Phase 6 PR-C — unit tests for `resolveChatDockLayout` clamp logic.
 */

import { describe, expect, it } from "vitest";
import {
  CHAT_DOCK_MAX_PX,
  CHAT_DOCK_MIN_PX,
  resolveChatDockLayout,
} from "../../client/src/lib/chat-dock-layout";

describe("resolveChatDockLayout", () => {
  it("hides the dock when mode is chat regardless of viewport", () => {
    expect(resolveChatDockLayout(800, "chat")).toEqual({ visible: false, widthPx: 0 });
    expect(resolveChatDockLayout(1280, "chat")).toEqual({ visible: false, widthPx: 0 });
    expect(resolveChatDockLayout(2560, "chat")).toEqual({ visible: false, widthPx: 0 });
  });

  it("hides the dock below VIEWPORT_MIN_PX (900) even in computer mode", () => {
    expect(resolveChatDockLayout(800, "computer")).toEqual({ visible: false, widthPx: 0 });
    expect(resolveChatDockLayout(899, "computer")).toEqual({ visible: false, widthPx: 0 });
  });

  it("clamps to MIN at the lower viewport boundary (just above 900)", () => {
    // 900 * 0.3 = 270 → clamp up to MIN (280).
    const r = resolveChatDockLayout(900, "computer");
    expect(r.visible).toBe(true);
    expect(r.widthPx).toBe(CHAT_DOCK_MIN_PX);
  });

  it("uses the 30vw fraction in the middle band", () => {
    // 1200 * 0.3 = 360 (between MIN 280 and MAX 480).
    const r = resolveChatDockLayout(1200, "computer");
    expect(r.visible).toBe(true);
    expect(r.widthPx).toBe(360);
  });

  it("clamps to MAX at the upper viewport boundary", () => {
    // 2560 * 0.3 = 768 → clamp down to MAX (480).
    const r = resolveChatDockLayout(2560, "computer");
    expect(r.visible).toBe(true);
    expect(r.widthPx).toBe(CHAT_DOCK_MAX_PX);
  });

  it("rounds to integer pixels (no sub-pixel widths)", () => {
    // 1234 * 0.3 = 370.2 → 370.
    expect(resolveChatDockLayout(1234, "computer").widthPx).toBe(370);
  });

  it("hits MAX exactly at the threshold viewport", () => {
    // 480 / 0.3 = 1600 → exactly MAX.
    expect(resolveChatDockLayout(1600, "computer").widthPx).toBe(CHAT_DOCK_MAX_PX);
  });
});

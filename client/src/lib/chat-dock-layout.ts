/**
 * Phase 6 PR-C — pure-logic layout helpers for ChatDock.
 *
 * The dock width follows BRO1 R446 Q1: `clamp(280px, 30vw, 480px)` for
 * desktop. Below `VIEWPORT_MIN_PX = 900` the canvas is hidden entirely
 * (LucaCanvas mode router already enforces this; we duplicate the
 * breakpoint here so the dock can defensively render zero-width if
 * mounted by mistake on small viewports).
 */

import { VIEWPORT_MIN_PX } from "./luca-canvas-mode";

export const CHAT_DOCK_MIN_PX = 280;
export const CHAT_DOCK_MAX_PX = 480;
export const CHAT_DOCK_VW_FRACTION = 0.3;

export interface ChatDockLayout {
  /** Whether the dock should render at all. */
  visible: boolean;
  /** Effective dock width in pixels (0 when not visible). */
  widthPx: number;
}

/**
 * Resolve the effective dock layout for a given viewport width and the
 * current canvas mode. We DON'T expose this to React state — it's a
 * pure helper used for tests and for inline `style` calculation in
 * components that prefer a number to a `clamp()` expression.
 */
export function resolveChatDockLayout(
  viewportWidth: number,
  mode: "chat" | "computer",
): ChatDockLayout {
  if (mode !== "computer") return { visible: false, widthPx: 0 };
  if (viewportWidth < VIEWPORT_MIN_PX) return { visible: false, widthPx: 0 };
  const ideal = viewportWidth * CHAT_DOCK_VW_FRACTION;
  const clamped = Math.min(
    CHAT_DOCK_MAX_PX,
    Math.max(CHAT_DOCK_MIN_PX, ideal),
  );
  return { visible: true, widthPx: Math.round(clamped) };
}

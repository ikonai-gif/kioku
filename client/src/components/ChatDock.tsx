/**
 * Phase 6 PR-C (R-luca-computer-ui) — narrow chat column for computer mode.
 *
 * Pure layout shell. Receives the existing chat list/composer as `children`
 * and renders them in a fixed-width column on the right of the canvas.
 * Width follows BRO1 R446 Q1: `clamp(280px, 30vw, 480px)`.
 *
 * Visibility is owned by the host page (partner-chat) which reads
 * `useLucaCanvas().mode` and only mounts ChatDock when mode === 'computer'.
 * Below `VIEWPORT_MIN_PX = 900` the LucaCanvas mode router forces chat
 * mode anyway, so the host won't mount us there.
 */

import type { ReactNode } from "react";

interface ChatDockProps {
  children: ReactNode;
  /** Optional override (tests, future mobile rework). */
  widthCss?: string;
}

export function ChatDock({
  children,
  widthCss = "clamp(280px, 30vw, 480px)",
}: ChatDockProps) {
  return (
    <aside
      data-testid="luca-chat-dock"
      className="flex flex-col h-full overflow-hidden flex-shrink-0"
      style={{
        width: widthCss,
        borderLeft: "1px solid rgba(255,255,255,0.06)",
        background: "rgba(10,15,30,0.85)",
      }}
    >
      {children}
    </aside>
  );
}

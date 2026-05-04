/**
 * Phase 6 PR-D (R-luca-computer-ui hot-fix) — page-level center canvas
 * mounted between ChatDock and the right panels when `mode === 'computer'`.
 *
 * Pure layout. No data-fetching, no WebSocket, no polling. Receives the
 * currently-active `live_frame` from the host (partner-chat) which derives
 * it from `useActiveLiveFrame`. This keeps CanvasCenter trivially testable
 * (snapshot two states: liveFrame=null → placeholder, liveFrame=match → iframe).
 *
 * Why a separate component (vs putting the iframe inline in partner-chat)?
 *   1. ActivityTimeline used to own the hero iframe. We're moving it OUT
 *      so the user sees a meaningful canvas even with timeline closed.
 *   2. Pure layout shell is easier for BRO1 to audit visually.
 *   3. Phase 7+ can promote ChatDock + CanvasCenter into a real grid layout
 *      without touching partner-chat further.
 */

import { Activity, Sparkles } from "lucide-react";

import { LiveBrowserFrame } from "./LiveBrowserFrame";

import type { ActiveLiveFrameMatch } from "@/lib/activity-timeline-variant";

interface Props {
  roomId: number | null;
  /**
   * Currently active running step's live_frame, derived by the host via
   * `useActiveLiveFrame`. Null = placeholder mode.
   */
  activeLiveFrame: ActiveLiveFrameMatch | null;
  /**
   * Whether we've finished the first poll yet. While "loading" we show a
   * subdued shimmer so the user doesn't see «Lука готов работать» flash
   * during a fresh page load with an actual running step.
   */
  firstPollState?: "loading" | "success" | "error";
}

export function CanvasCenter({ roomId, activeLiveFrame, firstPollState = "success" }: Props) {
  return (
    <section
      data-testid="luca-canvas-center"
      className="flex-1 h-full overflow-hidden flex flex-col"
      style={{
        minWidth: 0,
        // Soft inner gradient so the canvas reads as «its own surface»,
        // not a continuation of the page background.
        background:
          "radial-gradient(ellipse at top, rgba(201,163,64,0.04) 0%, rgba(10,15,30,0) 60%)",
      }}
    >
      {activeLiveFrame ? (
        <ActiveFrameView roomId={roomId} match={activeLiveFrame} />
      ) : firstPollState === "loading" ? (
        <LoadingView />
      ) : (
        <PlaceholderView />
      )}
    </section>
  );
}

// ── Subviews ─────────────────────────────────────────────────────────

function ActiveFrameView({
  roomId,
  match,
}: {
  roomId: number | null;
  match: ActiveLiveFrameMatch;
}) {
  return (
    <div
      data-testid="luca-canvas-center-live"
      className="flex-1 flex flex-col p-4 gap-3 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <Activity className="w-4 h-4 text-[#C9A340] animate-pulse" />
        <h2 className="text-sm font-semibold text-foreground">
          Лука работает в браузере
        </h2>
        <span className="text-[10px] text-muted-foreground/50 ml-auto font-mono">
          step {match.stepId.slice(0, 8)}
        </span>
      </div>

      {/* The iframe — full remaining height. LiveBrowserFrame caps aspect
          ratio internally (16:10) but as flex-1 child we let it expand. */}
      <div
        className="flex-1 rounded-lg overflow-hidden"
        style={{
          border: "1px solid rgba(201,163,64,0.2)",
          background: "rgba(0,0,0,0.4)",
          minHeight: 0,
        }}
      >
        <LiveBrowserFrame
          src={match.signedUrl}
          replayUrl={match.sourceUrl}
          roomId={roomId ?? undefined}
          stepId={match.stepId}
        />
      </div>
    </div>
  );
}

function PlaceholderView() {
  return (
    <div
      data-testid="luca-canvas-center-placeholder"
      className="flex-1 flex flex-col items-center justify-center px-6 text-center"
    >
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
        style={{
          background: "rgba(201,163,64,0.08)",
          border: "1px solid rgba(201,163,64,0.18)",
        }}
      >
        <Sparkles className="w-6 h-6 text-[#C9A340]/70" />
      </div>
      <h2 className="text-base font-semibold text-foreground/90 mb-1">
        Лука готов работать
      </h2>
      <p className="text-xs text-muted-foreground/70 max-w-sm leading-relaxed">
        Запросите задачу в чате — браузер агента, превью файлов и live-сессии
        будут появляться здесь.
      </p>
    </div>
  );
}

function LoadingView() {
  return (
    <div
      data-testid="luca-canvas-center-loading"
      className="flex-1 flex flex-col items-center justify-center px-6 text-center"
    >
      <div
        className="w-14 h-14 rounded-full flex items-center justify-center mb-4 animate-pulse"
        style={{
          background: "rgba(201,163,64,0.06)",
          border: "1px solid rgba(201,163,64,0.12)",
        }}
      >
        <Activity className="w-6 h-6 text-[#C9A340]/40" />
      </div>
      <p className="text-xs text-muted-foreground/50">проверяю активность…</p>
    </div>
  );
}

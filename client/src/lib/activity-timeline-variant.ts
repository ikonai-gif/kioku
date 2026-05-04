/**
 * Phase 6 PR-B (R-luca-computer-ui) — pure logic for ActivityTimeline variant
 * routing & live_frame promotion.
 *
 * `variant: 'auto'` reads `useLucaCanvas().mode`; explicit values bypass the
 * context (used by tests and Storybook). Default exported here so the React
 * component is a thin shell and we can keep this module purely synchronous.
 */

import type { LucaCanvasMode } from "./luca-canvas-mode";

export type ActivityTimelineVariant =
  | "sidebar"
  | "canvas"
  /**
   * Phase 6 PR-D (BRO1 R450 N2) — when the host page owns the canvas-level
   * `<CanvasCenter>` and renders the active live_frame there, ActivityTimeline
   * MUST NOT also mount its own `<LiveBrowserFrame>` hero (would be a double
   * iframe → BB session collision). Pass this variant explicitly from the
   * host (partner-chat) when CanvasCenter is mounted.
   */
  | "canvas-with-host"
  | "auto";
export type ResolvedActivityTimelineVariant =
  | "sidebar"
  | "canvas"
  | "canvas-with-host";

/**
 * Resolve the effective variant given a prop value and the current canvas
 * mode. `auto` (default) picks `canvas` when Luca is in computer mode and
 * `sidebar` otherwise. Explicit values are returned verbatim.
 */
export function resolveActivityVariant(
  prop: ActivityTimelineVariant | undefined,
  canvasMode: LucaCanvasMode | null | undefined,
): ResolvedActivityTimelineVariant {
  const v = prop ?? "auto";
  if (v === "sidebar") return "sidebar";
  if (v === "canvas") return "canvas";
  if (v === "canvas-with-host") return "canvas-with-host";
  // auto — derive from canvas mode (defensive: chat / null / undefined → sidebar)
  return canvasMode === "computer" ? "canvas" : "sidebar";
}

/** True iff this resolved variant should render the canvas-style chrome. */
export function isCanvasResolvedVariant(
  v: ResolvedActivityTimelineVariant,
): boolean {
  return v === "canvas" || v === "canvas-with-host";
}

/** True iff this variant should mount its OWN LiveBrowserFrame hero. */
export function shouldMountTimelineHero(
  v: ResolvedActivityTimelineVariant,
): boolean {
  return v === "canvas";
}

// ── Live-frame promotion ────────────────────────────────────────────────

/**
 * Minimal shape of an ActivityRow needed to find the active live_frame.
 * Kept structurally typed so consumers (ActivityTimeline, tests) don't have to
 * pass full objects.
 */
export interface ActiveLiveFrameInput {
  stepId: string;
  status: string;
  startedAt: number;
  mediaUrls?: ReadonlyArray<{
    kind: string;
    signedUrl: string;
    sourceUrl?: string | null;
  }>;
}

export interface ActiveLiveFrameMatch {
  stepId: string;
  signedUrl: string;
  sourceUrl: string | null;
  startedAt: number;
}

/**
 * Pick the live_frame that should occupy the canvas hero. Selection rules:
 * 1. Only `status: 'running'` rows qualify (server tears down BB session on
 *    done/error so the URL is dead).
 * 2. Among qualifying rows, prefer the one with the most recent `startedAt`.
 * 3. If multiple rows share `startedAt`, the last one in the input wins
 *    (matches the natural append order).
 *
 * Returns `null` when no row qualifies.
 */
export function selectActiveLiveFrame(
  rows: ReadonlyArray<ActiveLiveFrameInput>,
): ActiveLiveFrameMatch | null {
  let best: ActiveLiveFrameMatch | null = null;
  for (const r of rows) {
    if (r.status !== "running") continue;
    const lf = r.mediaUrls?.find((m) => m.kind === "live_frame");
    if (!lf) continue;
    const candidate: ActiveLiveFrameMatch = {
      stepId: r.stepId,
      signedUrl: lf.signedUrl,
      sourceUrl: lf.sourceUrl ?? null,
      startedAt: r.startedAt,
    };
    if (!best || candidate.startedAt >= best.startedAt) {
      best = candidate;
    }
  }
  return best;
}

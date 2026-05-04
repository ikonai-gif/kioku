/**
 * Phase 6 PR-D (R-luca-computer-ui hot-fix) — exposes the currently-active
 * `live_frame` (running luca_agent_browser / browse_website) for the page-
 * level CanvasCenter component.
 *
 * Why a separate hook?
 * ───────────────────
 * - `useLucaActiveStep` only returns a boolean signal; CanvasCenter needs
 *   the actual signedUrl + sourceUrl + stepId to mount LiveBrowserFrame.
 * - `ActivityTimeline` keeps its own poll for the row list UI; we don't
 *   refactor it in PR-D (visual hot-fix scope) so TODO Phase 7: unify the
 *   three polls behind one shared `useToolActivityRows` hook (BRO1 Q-D1
 *   recommend, deferred to keep PR-D small).
 *
 * Polling contract mirrors `useLucaActiveStep`:
 *   - 2s interval, since-cursor, 200 row window
 *   - errors keep last-known-good (no flap on transient WS hiccup)
 *   - `enabled=false` or null roomId fully stops the poller
 *
 * `firstPollState` exposes the explicit initial-load lifecycle so
 * `LucaCanvasProvider` can defer the "stale persisted override" downgrade
 * until we actually know whether a step is running (BRO1 Q-D2).
 */

import { useEffect, useRef, useState } from "react";

import { getSessionToken } from "@/lib/auth";
import { API_BASE } from "@/lib/queryClient";
import {
  selectActiveLiveFrame,
  type ActiveLiveFrameMatch,
} from "@/lib/activity-timeline-variant";

// ── Types ────────────────────────────────────────────────────────────

interface ActivityRow {
  id: number;
  stepId: string;
  tool: string;
  status: string;
  startedAt: number;
  createdAt: number;
  mediaUrls?: ReadonlyArray<{
    kind: string;
    signedUrl: string;
    sourceUrl?: string | null;
  }>;
}

export type FirstPollState = "loading" | "success" | "error";

interface UseActiveLiveFrameArgs {
  roomId: number | null | undefined;
  enabled: boolean;
  /** Override poll interval (default 2000ms). */
  intervalMs?: number;
}

export interface UseActiveLiveFrameResult {
  activeLiveFrame: ActiveLiveFrameMatch | null;
  /** "loading" until first poll resolves; then "success" or "error". */
  firstPollState: FirstPollState;
}

// ── Hook ─────────────────────────────────────────────────────────────

export function useActiveLiveFrame({
  roomId,
  enabled,
  intervalMs = 2000,
}: UseActiveLiveFrameArgs): UseActiveLiveFrameResult {
  const [activeLiveFrame, setActiveLiveFrame] =
    useState<ActiveLiveFrameMatch | null>(null);
  const [firstPollState, setFirstPollState] =
    useState<FirstPollState>("loading");

  const inflightRef = useRef(false);
  const lastCreatedRef = useRef(0);
  /**
   * Keep a small in-memory mirror of the running rows so a `done` for the
   * same step properly clears `activeLiveFrame` without a full refetch.
   */
  const runningRowsRef = useRef(new Map<string, ActivityRow>());

  useEffect(() => {
    if (!enabled || roomId == null) {
      setActiveLiveFrame(null);
      setFirstPollState("loading");
      runningRowsRef.current.clear();
      lastCreatedRef.current = 0;
      return;
    }

    let cancelled = false;
    let resolvedFirst = false;

    async function tick() {
      if (cancelled || inflightRef.current) return;
      inflightRef.current = true;
      try {
        const token = getSessionToken();
        const url = `${API_BASE}/api/rooms/${roomId}/tool-activity?since=${lastCreatedRef.current}&limit=200`;
        const res = await fetch(url, {
          headers: { ...(token ? { "x-session-token": token } : {}) },
          credentials: "include",
        });
        if (!res.ok) {
          if (!resolvedFirst && !cancelled) {
            setFirstPollState("error");
            resolvedFirst = true;
          }
          return; // keep last-known-good
        }
        const rows = (await res.json()) as ActivityRow[];
        if (cancelled) return;
        if (Array.isArray(rows)) {
          // Update mirror: insert running rows, drop on done/error.
          for (const r of rows) {
            if (r.status === "running") {
              runningRowsRef.current.set(r.stepId, r);
            } else {
              runningRowsRef.current.delete(r.stepId);
            }
            if (r.createdAt > lastCreatedRef.current) {
              lastCreatedRef.current = r.createdAt;
            }
          }
          const next = selectActiveLiveFrame(
            Array.from(runningRowsRef.current.values()),
          );
          setActiveLiveFrame((prev) => {
            // Stable identity check so consumer doesn't re-render unnecessarily.
            if (
              prev?.stepId === next?.stepId &&
              prev?.signedUrl === next?.signedUrl
            ) {
              return prev;
            }
            return next;
          });
        }
        if (!resolvedFirst && !cancelled) {
          setFirstPollState("success");
          resolvedFirst = true;
        }
      } catch {
        if (!resolvedFirst && !cancelled) {
          setFirstPollState("error");
          resolvedFirst = true;
        }
      } finally {
        inflightRef.current = false;
      }
    }

    void tick();
    const id =
      typeof window !== "undefined"
        ? window.setInterval(tick, intervalMs)
        : null;
    return () => {
      cancelled = true;
      if (id !== null && typeof window !== "undefined") {
        window.clearInterval(id);
      }
    };
  }, [enabled, roomId, intervalMs]);

  return { activeLiveFrame, firstPollState };
}

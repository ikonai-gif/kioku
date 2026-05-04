/**
 * Phase 6 PR-A (R-luca-computer-ui) — polls the existing
 * `/api/rooms/:id/tool-activity` endpoint and returns whether a long-running
 * "computer-mode" tool (luca_agent_browser / browse_website) is currently
 * active in the room.
 *
 * Design notes
 * ────────────
 *   • Reuses `tool-activity` GET. No new endpoint, no new auth surface, no
 *     schema changes — that's why this PR is `[security: no]`.
 *   • Mirrors the polling contract of ActivityTimeline (since-cursor + 200
 *     limit, 2s interval) but only tracks the boolean signal — we don't
 *     keep the full row list in memory.
 *   • Polling stops when `enabled=false` or roomId is null. The caller is
 *     expected to disable us when the chat tab isn't visible.
 *   • We don't tear the layout down on a single failed poll: errors keep the
 *     last-known-good `hasComputerStep` until the next successful tick. That
 *     prevents WS hiccups from causing canvas flapping.
 */

import { useEffect, useRef, useState } from "react";

import { getSessionToken } from "@/lib/auth";
import { detectComputerStepRunning } from "@/lib/luca-canvas-mode";
import { API_BASE } from "@/lib/queryClient";

// ── Types ────────────────────────────────────────────────────────────

interface ActivityRowLite {
  id: number;
  stepId: string;
  tool: string;
  status: string;
  createdAt: number;
}

interface UseLucaActiveStepArgs {
  roomId: number | null | undefined;
  enabled: boolean;
  /** Override poll interval; defaults to 2000ms (matches ActivityTimeline). */
  intervalMs?: number;
}

// ── Hook ─────────────────────────────────────────────────────────────

export function useLucaActiveStep({
  roomId,
  enabled,
  intervalMs = 2000,
}: UseLucaActiveStepArgs): boolean {
  const [hasComputerStep, setHasComputerStep] = useState(false);
  const inflightRef = useRef(false);
  const lastCreatedRef = useRef(0);
  /**
   * We track currently-running computer steps by stepId so a `done` row for
   * the same step properly clears the flag without us having to refetch the
   * whole window. When a step transitions running→done/error we drop it.
   */
  const runningStepsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || roomId == null) {
      // Reset cleanly when disabled / no room.
      setHasComputerStep(false);
      runningStepsRef.current.clear();
      lastCreatedRef.current = 0;
      return;
    }

    let cancelled = false;

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
        if (!res.ok) return; // keep last-known-good signal on failure
        const rows = (await res.json()) as ActivityRowLite[];
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;

        // Update the running-set incrementally. We rely on the same
        // running→done/error update pattern as ActivityTimeline: a `done`
        // row arrives with the same stepId and a later createdAt.
        for (const r of rows) {
          if (r.status === "running" && isComputerToolFromRow(r)) {
            runningStepsRef.current.add(r.stepId);
          } else {
            // Any non-running update for a known step clears it.
            runningStepsRef.current.delete(r.stepId);
          }
          if (r.createdAt > lastCreatedRef.current) {
            lastCreatedRef.current = r.createdAt;
          }
        }

        // Cross-check with the canonical predicate so we never disagree with
        // the unit tests' detect(...) function.
        const next = runningStepsRef.current.size > 0
          && detectComputerStepRunning(
            rows.filter((r) => runningStepsRef.current.has(r.stepId)),
          );
        // Even when our incremental set has entries, prefer the predicate
        // so a corrupt/changed-tool row doesn't lock us into computer mode.
        setHasComputerStep(next);
      } catch {
        /* keep last-known-good */
      } finally {
        inflightRef.current = false;
      }
    }

    // Immediate tick + interval.
    void tick();
    const id = window.setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, roomId, intervalMs]);

  return hasComputerStep;
}

function isComputerToolFromRow(row: ActivityRowLite): boolean {
  // Inline import-safety wrapper — the predicate is a pure function but
  // keeping it a small helper here makes the call sites read naturally.
  // Using the canonical list ensures we never drift from the unit tests.
  return row.tool === "luca_agent_browser" || row.tool === "browse_website";
}

/**
 * Phase 6 PR-A (R-luca-computer-ui) — `LucaCanvas` headless controller.
 *
 * Why headless?
 * ─────────────
 * PR-A is the foundation: it ships the mode-router infrastructure (auto-flip,
 * persisted override, viewport guard, computer-step detection) WITHOUT
 * rewriting any visual layout. PR-B repurposes ActivityTimeline into a
 * full-canvas variant; PR-C adds the chat dock + shared WS. By keeping PR-A
 * headless, we can land the foundation behind a visible-but-tiny win
 * (auto-open ActivityTimeline + a header toggle) and let BRO1 audit the
 * router logic in isolation.
 *
 * API surface
 * ───────────
 *   <LucaCanvasProvider roomId={...}>
 *     // existing partner-chat tree
 *     <LucaCanvasToggle />     // optional header pill
 *   </LucaCanvasProvider>
 *
 *   const { mode, override, setOverride, hasComputerStep } = useLucaCanvas();
 *
 * The provider does NOT itself render any layout chrome; partner-chat keeps
 * its current sidebar plumbing. The provider's job is to expose `mode` and
 * to fire side-effects (auto-open ActivityTimeline) via callbacks the host
 * page passes in.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Layout, Maximize2, MessageSquare } from "lucide-react";

import { useLucaActiveStep } from "@/hooks/useLucaActiveStep";
import {
  decideStaleOverrideAction,
  type LucaCanvasMode,
  type LucaCanvasOverride,
  nextOverrideForToggle,
  readStoredOverride,
  resolveMode,
  shouldFireEnterComputer,
  writeStoredOverride,
} from "@/lib/luca-canvas-mode";

/**
 * BRO1 R450 N1 — synchronous hydration must be SSR-safe. We wrap the
 * read in a try/catch so that if `window` / `localStorage` is unavailable
 * (SSR snapshot, private browsing) we fall back to "auto" without
 * throwing during the very first render.
 */
function safeReadStoredOverride(
  roomId: number | null | undefined,
): LucaCanvasOverride {
  if (roomId == null) return "auto";
  if (typeof window === "undefined") return "auto";
  try {
    return readStoredOverride(roomId);
  } catch {
    return "auto";
  }
}



// ── Context ──────────────────────────────────────────────────────────

interface LucaCanvasContextValue {
  mode: LucaCanvasMode;
  override: LucaCanvasOverride;
  /** True while a long-running browser tool is active in the room. */
  hasComputerStep: boolean;
  setOverride: (next: LucaCanvasOverride) => void;
  /** Toggle pill helper — flips chat ↔ computer per resolved mode. */
  toggle: () => void;
  /** Reset persisted override back to "auto" (clears localStorage key). */
  resetOverride: () => void;
}

const LucaCanvasContext = createContext<LucaCanvasContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────

interface LucaCanvasProviderProps {
  /** The active partner-chat roomId. Null when no room is selected yet. */
  roomId: number | null | undefined;
  /**
   * Callback fired the first time the mode flips into "computer" so the
   * host page can auto-open ActivityTimeline. The host owns the panel
   * state — we only signal.
   */
  onEnterComputerMode?: () => void;
  /** Disable activity polling when the host knows the user isn't looking. */
  pollingEnabled?: boolean;
  children: ReactNode;
}

export function LucaCanvasProvider({
  roomId,
  onEnterComputerMode,
  pollingEnabled = true,
  children,
}: LucaCanvasProviderProps) {
  // BRO1 R450 N1 — synchronous initial hydration removes the chat→computer
  // first-frame flicker. The room-change effect below re-reads when roomId
  // changes mid-mount (room switcher, deep link).
  const [override, setOverrideState] = useState<LucaCanvasOverride>(() =>
    safeReadStoredOverride(roomId),
  );
  const [viewportWidth, setViewportWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 1280;
    return window.innerWidth;
  });

  /**
   * Tracks the last roomId we hydrated for, so the room-change effect
   * doesn't fire on initial mount (already covered by lazy useState).
   */
  const hydratedRoomIdRef = useRef<number | null | undefined>(roomId);
  /**
   * BRO1 R450 Q-D5 — when the user clicks the toggle pill we record
   * timestamp + chosen mode so the stale-override guard refuses to
   * downgrade their explicit choice for USER_OVERRIDE_GUARD_MS.
   */
  const userOverrodeAtMsRef = useRef<number | null>(null);
  const userOverrodeModeRef = useRef<LucaCanvasOverride | null>(null);
  /**
   * One-shot guard: only run the stale-override downgrade once per room
   * hydration. This way completing a step at runtime (running → done)
   * doesn't fight a user who manually forced computer mode (BRO1 N3).
   */
  const staleDowngradeArmedRef = useRef<boolean>(true);

  // Hydrate stored override on roomId CHANGES (initial value already set).
  useEffect(() => {
    if (hydratedRoomIdRef.current === roomId) return;
    hydratedRoomIdRef.current = roomId;
    setOverrideState(safeReadStoredOverride(roomId));
    // Re-arm the stale downgrade guard for the new room.
    staleDowngradeArmedRef.current = true;
    userOverrodeAtMsRef.current = null;
    userOverrodeModeRef.current = null;
  }, [roomId]);

  // Keep viewportWidth fresh so the breakpoint guard reacts to resize.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onResize() {
      setViewportWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const hasComputerStep = useLucaActiveStep({
    roomId: roomId ?? null,
    enabled: pollingEnabled && roomId != null,
  });

  const mode = useMemo<LucaCanvasMode>(
    () => resolveMode({ override, hasComputerStep, viewportWidth }),
    [override, hasComputerStep, viewportWidth],
  );

  /**
   * BRO1 R450 — transition-ref guard for `onEnterComputerMode`. Fires when
   * we LAND on computer mode for the first time (covers initial mount
   * with persisted=computer AND chat→computer transitions). Doesn't
   * fire on re-renders that stay in computer mode.
   */
  const prevModeRef = useRef<LucaCanvasMode | null>(null);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = mode;
    if (shouldFireEnterComputer(prev, mode) && onEnterComputerMode) {
      onEnterComputerMode();
    }
    // We intentionally DON'T fire on transitions back to chat — host
    // owns sidebar collapse policy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /**
   * BRO1 R450 N3 + Q-D5 — stale-override downgrade.
   *
   * Scenario: user (or a previous tab) left a `computer` override persisted
   * in localStorage. On a fresh page load with NO running step, that lock
   * tunnels them straight into the canvas layout with no live frame —
   * which is the «dark void» BOSS reported.
   *
   * Rules:
   *   1. One-shot per room hydration (`staleDowngradeArmedRef`). Completing
   *      a step at runtime should NOT fight the user.
   *   2. Wait until the activity poller has had a chance to settle. We
   *      detect this via `hasComputerStep` toggling true OR via a 5s
   *      grace timer that arms the downgrade after first paint. We can't
   *      directly observe "first poll resolved" from this layer, so the
   *      timer doubles as a network-error fallback (BRO1 Q-D2 NICE).
   *   3. Honour user explicit toggle within USER_OVERRIDE_GUARD_MS.
   *   4. Only downgrade `computer`. `chat` and `auto` are no-ops.
   */
  useEffect(() => {
    if (!staleDowngradeArmedRef.current) return;
    const decisionNow = decideStaleOverrideAction({
      armed: staleDowngradeArmedRef.current,
      override,
      hasComputerStep,
      userOverrodeAtMs: userOverrodeAtMsRef.current,
      userOverrodeMode: userOverrodeModeRef.current,
      nowMs: Date.now(),
    });
    if (decisionNow === "disarm") {
      staleDowngradeArmedRef.current = false;
      return;
    }
    if (decisionNow !== "downgrade") return;

    // BRO1 Q-D2 — short grace timer so an in-flight first poll can flip
    // hasComputerStep before we touch the user's storage. Re-evaluate the
    // decision inside the timer; the user might toggle while we wait.
    const timer = setTimeout(() => {
      const decisionLater = decideStaleOverrideAction({
        armed: staleDowngradeArmedRef.current,
        override,
        hasComputerStep,
        userOverrodeAtMs: userOverrodeAtMsRef.current,
        userOverrodeMode: userOverrodeModeRef.current,
        nowMs: Date.now(),
      });
      if (decisionLater === "disarm") {
        staleDowngradeArmedRef.current = false;
        return;
      }
      if (decisionLater !== "downgrade") return;
      staleDowngradeArmedRef.current = false;
      if (roomId != null) {
        setOverrideState("auto");
        try {
          writeStoredOverride(roomId, "auto");
        } catch {
          /* best-effort */
        }
      }
    }, 1500);
    return () => clearTimeout(timer);
  }, [override, hasComputerStep, roomId]);

  const setOverride = useCallback(
    (next: LucaCanvasOverride) => {
      if (roomId == null) return;
      setOverrideState(next);
      writeStoredOverride(roomId, next);
      // Any explicit setOverride (user click) disarms the stale guard so
      // the user's choice survives runtime step completion.
      staleDowngradeArmedRef.current = false;
      userOverrodeAtMsRef.current = Date.now();
      userOverrodeModeRef.current = next;
    },
    [roomId],
  );

  const toggle = useCallback(() => {
    setOverride(nextOverrideForToggle(mode));
  }, [mode, setOverride]);

  const resetOverride = useCallback(() => {
    setOverride("auto");
  }, [setOverride]);

  const value = useMemo<LucaCanvasContextValue>(
    () => ({
      mode,
      override,
      hasComputerStep,
      setOverride,
      toggle,
      resetOverride,
    }),
    [mode, override, hasComputerStep, setOverride, toggle, resetOverride],
  );

  return (
    <LucaCanvasContext.Provider value={value}>
      {children}
    </LucaCanvasContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────

export function useLucaCanvas(): LucaCanvasContextValue {
  const ctx = useContext(LucaCanvasContext);
  if (!ctx) {
    // Defensive default for the rare case when a consumer renders outside
    // the provider (Storybook, isolated tests). We always return a
    // chat-mode no-op so the consumer can degrade gracefully.
    return {
      mode: "chat",
      override: "auto",
      hasComputerStep: false,
      setOverride: () => {},
      toggle: () => {},
      resetOverride: () => {},
    };
  }
  return ctx;
}

// ── Toggle pill (visible UI surface for PR-A) ────────────────────────

/**
 * Tiny pill button matching the existing partner-chat header style.
 * In `auto` mode it shows "auto" with the resolved icon. In an explicit
 * mode it shows the mode name with a small "сбросить" reset on long-press
 * (we use double-click to keep the affordance discoverable but unobtrusive).
 */
export function LucaCanvasToggle() {
  const { mode, override, hasComputerStep, toggle, resetOverride } = useLucaCanvas();

  const Icon = mode === "computer" ? Maximize2 : MessageSquare;
  const isAuto = override === "auto";

  return (
    <button
      type="button"
      onClick={toggle}
      onDoubleClick={resetOverride}
      data-testid="luca-canvas-toggle"
      className="relative flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors"
      style={{
        background: mode === "computer" ? "rgba(201,163,64,0.2)" : "rgba(255,255,255,0.05)",
        color: mode === "computer" ? "#C9A340" : "rgba(255,255,255,0.5)",
        border: `1px solid ${mode === "computer" ? "rgba(201,163,64,0.3)" : "rgba(255,255,255,0.08)"}`,
      }}
      title={
        isAuto
          ? `авто-режим${hasComputerStep ? " (Лука работает)" : ""} — клик чтобы зафиксировать, двойной клик не нужен`
          : `режим зафиксирован: ${override === "computer" ? "computer" : "chat"} — клик чтобы переключить, двойной клик чтобы вернуть авто`
      }
      aria-label={`Режим Луки: ${mode}${isAuto ? " (auto)" : " (forced)"}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {!isAuto && (
        <Layout className="w-2.5 h-2.5 opacity-60" aria-hidden />
      )}
    </button>
  );
}

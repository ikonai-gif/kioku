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
  useState,
  type ReactNode,
} from "react";

import { Layout, Maximize2, MessageSquare } from "lucide-react";

import { useLucaActiveStep } from "@/hooks/useLucaActiveStep";
import {
  type LucaCanvasMode,
  type LucaCanvasOverride,
  nextOverrideForToggle,
  readStoredOverride,
  resolveMode,
  writeStoredOverride,
} from "@/lib/luca-canvas-mode";

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
  const [override, setOverrideState] = useState<LucaCanvasOverride>("auto");
  const [viewportWidth, setViewportWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 1280;
    return window.innerWidth;
  });

  // Hydrate stored override per-room.
  useEffect(() => {
    if (roomId == null) {
      setOverrideState("auto");
      return;
    }
    setOverrideState(readStoredOverride(roomId));
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

  // Fire onEnterComputerMode exactly when we transition chat → computer.
  // We track the previous resolved mode in a ref-style state so the host
  // page can react idempotently (it'll typically just open ActivityTimeline).
  useEffect(() => {
    if (mode === "computer" && onEnterComputerMode) {
      onEnterComputerMode();
    }
    // We intentionally DON'T fire on transitions back to chat — host can
    // decide for itself whether to collapse the sidebar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const setOverride = useCallback(
    (next: LucaCanvasOverride) => {
      if (roomId == null) return;
      setOverrideState(next);
      writeStoredOverride(roomId, next);
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

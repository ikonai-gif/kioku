/**
 * Phase 4 (R-luca-computer-ui) — ChatGPT-Atlas / Claude-Code style live
 * Browserbase preview iframe.
 *
 * Phase 5 PR-B (R-luca-computer-ui): Boss can take over the iframe to drive
 * Stagehand's session manually while the agent loop yields. Wire-up:
 *   • Click the "взять управление" pill → WS `liveFrameTakeover` mode=interactive.
 *   • Server flips a per-stepId lock (luca-takeover.ts) and broadcasts
 *     `liveFrameTakeoverState` to the room. We watch that broadcast for our
 *     own state (single source of truth, multi-tab safe).
 *   • While `active && mode==='interactive'`, the iframe gets pointerEvents:'auto'
 *     and a red border + "Босс управляет — Лука ждёт" badge.
 *   • Click "вернуть управление" → WS `liveFrameTakeover` mode=release;
 *     server clears the lock and re-broadcasts `active:false`.
 *   • Step ends (server tears the iframe down via closeLiveFrame:true on the
 *     activity row) and the parent unmounts us — local state is GC'd.
 */

import { useEffect, useRef, useState } from "react";
import { Globe, Hand } from "lucide-react";

interface Props {
  /** Browserbase `debuggerFullscreenUrl`. */
  src: string;
  /**
   * Optional session-replay URL. Surfaced as a tiny "open replay" footer
   * so Boss can keep watching after the live session ends.
   */
  replayUrl?: string | null;
  /** Phase 5 PR-B — needed to send WS takeover messages. */
  roomId?: number;
  stepId?: string;
}

/**
 * Hook: returns true while `document.visibilityState === 'visible'`.
 * Defaults to true on environments without a `document` (jsdom can vary).
 */
function useVisibility(): boolean {
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof document === "undefined") return true;
    return document.visibilityState !== "hidden";
  });
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);
  return visible;
}

/**
 * Phase 5 PR-B — connect to the room WS to send takeover messages and
 * react to server-broadcast state. We piggyback on the existing room WS
 * (`/ws`); no new connection. The hook returns the active state (so the
 * iframe can flip pointerEvents) and a `request(mode)` helper.
 *
 * The room subscription is owned by the parent (ActivityTimeline already
 * subscribes); here we open a thin sender-only WS for outbound messages.
 * That keeps coupling minimal — broadcast events route through the
 * existing WsBroadcast pipe (window event below).
 */
function useTakeover(roomId: number | undefined, stepId: string | undefined) {
  const [active, setActive] = useState(false);
  const [holderIsMe, setHolderIsMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!roomId || !stepId) return;
    if (typeof window === "undefined") return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", roomId }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (msg.type === "liveFrameTakeoverState" && msg.stepId === stepId) {
          setActive(Boolean(msg.active && msg.mode === "interactive"));
          // We don't have a reliable connection-id echo client-side; treat
          // the holder as "me" while our last ack was an acquire and
          // server-state is still active. The optimistic flag flips back
          // off whenever an `active:false` lands.
          if (!msg.active) setHolderIsMe(false);
        }
        if (msg.type === "liveFrameTakeoverAck" && msg.stepId === stepId) {
          setError(null);
          if (msg.mode === "interactive" || msg.mode === "passive") {
            setHolderIsMe(true);
          } else if (msg.mode === "release") {
            setHolderIsMe(false);
          }
        }
        if (msg.type === "liveFrameTakeoverError" && msg.stepId === stepId) {
          setError(String(msg.code || "unknown"));
        }
      } catch { /* best-effort */ }
    });
    ws.addEventListener("close", () => { wsRef.current = null; });

    return () => {
      try { ws.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [roomId, stepId]);

  function request(mode: "interactive" | "release") {
    if (!roomId || !stepId) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setError(null);
    ws.send(JSON.stringify({ type: "liveFrameTakeover", roomId, stepId, mode }));
  }

  return { active, holderIsMe, error, request };
}

export function LiveBrowserFrame({ src, replayUrl, roomId, stepId }: Props) {
  const visible = useVisibility();
  const { active, holderIsMe, error, request } = useTakeover(roomId, stepId);
  // Boss drives the iframe only if he's the active holder. Other tabs (or
  // cross-user) see active=true but holderIsMe=false → still passive.
  const interactive = active && holderIsMe;

  return (
    <div
      className="w-full rounded-md overflow-hidden"
      style={{
        background: "rgba(0,0,0,0.5)",
        // Phase 5 PR-B — red border while Boss is in the seat to make it
        // unambiguous which surface receives clicks.
        border: interactive
          ? "1px solid rgba(220,38,38,0.8)"
          : "1px solid rgba(201,163,64,0.2)",
        aspectRatio: "16 / 10",
        position: "relative",
      }}
    >
      {visible ? (
        <iframe
          // BB official sample: sandbox MUST keep allow-same-origin so the
          // BB devtools UI inside the iframe can read its own cookies and
          // localStorage. Cross-origin parent (us) keeps it isolated.
          sandbox="allow-same-origin allow-scripts"
          // Match BB official sample. NO allow-popups (OAuth happens inside
          // the BB browser, not a parent popup) and NO allow-forms (the BB
          // devtools UI doesn't submit forms back to the parent).
          allow="clipboard-read; clipboard-write"
          referrerPolicy="no-referrer"
          src={src}
          title="Live agent browser"
          style={{
            width: "100%",
            height: "100%",
            border: 0,
            // Phase 4 default: passive view. Phase 5 PR-B flips to 'auto'
            // ONLY for the active holder. Other observers stay passive.
            pointerEvents: interactive ? "auto" : "none",
          }}
        />
      ) : (
        <div
          className="w-full h-full flex items-center justify-center text-[11px] text-muted-foreground/60"
          aria-label="Live preview paused (tab hidden)"
        >
          <div className="flex flex-col items-center gap-1.5">
            <Globe className="w-4 h-4 text-[#C9A340]/60" />
            <span>предпросмотр приостановлен</span>
          </div>
        </div>
      )}

      {/* Phase 5 PR-B — takeover controls + state badge. */}
      {roomId && stepId && (
        <div className="absolute top-1 left-1 flex items-center gap-1.5">
          {interactive ? (
            <>
              <span
                className="text-[9px] font-medium uppercase tracking-wide rounded px-1.5 py-0.5"
                style={{ background: "rgba(220,38,38,0.85)", color: "white" }}
              >
                Босс управляет — Лука ждёт
              </span>
              <button
                type="button"
                onClick={() => request("release")}
                className="text-[9px] rounded px-1.5 py-0.5 hover:bg-black/40 text-white/90 border border-white/20"
                aria-label="Вернуть управление агенту"
              >
                вернуть управление
              </button>
            </>
          ) : active ? (
            <span
              className="text-[9px] rounded px-1.5 py-0.5"
              style={{ background: "rgba(0,0,0,0.55)", color: "rgba(255,255,255,0.85)" }}
            >
              кто-то уже управляет
            </span>
          ) : (
            <button
              type="button"
              onClick={() => request("interactive")}
              className="text-[9px] rounded px-1.5 py-0.5 hover:bg-black/40 text-[#C9A340] border border-[#C9A340]/40 flex items-center gap-1"
              aria-label="Взять управление"
            >
              <Hand className="w-3 h-3" />
              взять управление
            </button>
          )}
          {error && (
            <span
              className="text-[9px] rounded px-1.5 py-0.5"
              style={{ background: "rgba(220,38,38,0.55)", color: "white" }}
              title={error}
            >
              {error === "RATE_LIMITED" ? "слишком часто" :
               error === "STEP_FINISHED" ? "шаг завершён" :
               error === "LOCKED" ? "занято" :
               "ошибка"}
            </span>
          )}
        </div>
      )}

      {replayUrl && (
        <a
          href={replayUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-1 right-1 text-[9px] text-[#C9A340]/70 hover:text-[#C9A340] underline"
        >
          replay
        </a>
      )}
    </div>
  );
}

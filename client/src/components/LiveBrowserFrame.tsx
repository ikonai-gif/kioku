/**
 * Phase 4 (R-luca-computer-ui) \u2014 ChatGPT-Atlas / Claude-Code style live
 * Browserbase preview iframe. Mounted while `luca_agent_browser` is running
 * so Boss watches the agent click in real time, then auto-removed on
 * `closeLiveFrame:true` / status:'done' / `visibilitychange=hidden`.
 *
 * BRO1 R436 must-fixes:
 *   #4.1  sandbox="allow-same-origin allow-scripts" \u2014 Browserbase official
 *         sample; cross-origin (browserbase.com \u2260 usekioku.com) so the combo
 *         is safe (the same-origin only collapses sandbox when the iframe
 *         shares origin with the parent).
 *   #4.2  pointerEvents:'none' on the <iframe> \u2014 passive view; takeover is
 *         deferred to Phase 5. Boss can't accidentally type or click into
 *         the agent's session.
 *
 * BRO1 R431 must-fix #3 (pause when hidden): on `visibilitychange=hidden`
 * we UNMOUNT the iframe entirely (not just `display:none`) so Browserbase
 * pauses billing on idle background tabs ($0.10/min adds up).
 *
 * Audio/permissions: `allow="clipboard-read; clipboard-write"` only \u2014
 * matches BB official sample. Audio mute is unnecessary (BB tabs are silent
 * by default; autoplay is browser-blocked).
 */

import { useEffect, useState } from "react";
import { Globe } from "lucide-react";

interface Props {
  /** Browserbase `debuggerFullscreenUrl`. */
  src: string;
  /**
   * Optional session-replay URL. Surfaced as a tiny "open replay" footer
   * so Boss can keep watching after the live session ends.
   */
  replayUrl?: string | null;
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

export function LiveBrowserFrame({ src, replayUrl }: Props) {
  const visible = useVisibility();
  return (
    <div
      className="w-full rounded-md overflow-hidden"
      style={{
        background: "rgba(0,0,0,0.5)",
        border: "1px solid rgba(201,163,64,0.2)",
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
            // BRO1 R436 must-fix #4.2: passive view. Boss can watch but
            // not interact. Takeover \u2192 Phase 5.
            pointerEvents: "none",
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

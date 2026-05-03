/**
 * Phase 4 (R-luca-computer-ui) \u2014 ephemeral Browserbase "live preview"
 * iframe persistence helpers for agent_browser.
 *
 * Unlike Phase 2/3 helpers, NOTHING is uploaded to Supabase here \u2014 the
 * URL we attach is Browserbase's own short-lived `debuggerFullscreenUrl`.
 * It contains an embedded auth token and stops resolving the moment the
 * Browserbase session terminates (~stagehand.close()).
 *
 * BRO1 R436 must-fixes:
 *   #4.1  Browser CSP frameSrc covers `https://*.browserbase.com` (added
 *         in `server/security.ts`). Sandbox = "allow-same-origin allow-scripts"
 *         on the client iframe \u2014 cross-origin so combo is safe.
 *   #4.2  pointerEvents: 'none' on the iframe (passive view; takeover \u2192 v2).
 *
 * BRO1 R431 must-fix #4 (append-semantics) is enforced by
 * `setToolActivityMedia` itself (read \u2192 merge \u2192 write).
 */

import type { ToolActivityMedia } from "../../storage";

/**
 * Browserbase session TTL ceiling \u2014 sessions auto-expire after ~1h. We use
 * the same value for `signedExpiresAt` so the client can warn when the
 * preview is about to die. NOT enforced server-side (the URL is BB's
 * problem) \u2014 just a UI hint.
 */
export const LIVE_FRAME_TTL_SEC = 60 * 60;

export interface LiveFrameMedia {
  /** Empty string \u2014 there is no bucket file. parseMediaCol allows this for kind:'live_frame'. */
  storageKey: "";
  /** Browserbase `debuggerFullscreenUrl` (iframe-friendly). */
  signedUrl: string;
  signedExpiresAt: number;
  /** Synthetic content-type \u2014 mirrors how live_frame is "the page itself". */
  contentType: "text/html";
  kind: "live_frame";
  /** The session-replay URL so the user can later open the recording. */
  sourceUrl: string;
}

export function buildLiveFrameMedia(args: {
  debuggerFullscreenUrl: string;
  sessionReplayUrl: string;
}): LiveFrameMedia {
  return {
    storageKey: "",
    signedUrl: args.debuggerFullscreenUrl,
    signedExpiresAt: Date.now() + LIVE_FRAME_TTL_SEC * 1000,
    contentType: "text/html",
    kind: "live_frame",
    sourceUrl: args.sessionReplayUrl,
  };
}

/**
 * Convert LiveFrameMedia \u2192 the snake_case JSONB shape expected on the wire
 * (`broadcastToolActivity.mediaUrls[]`). Symmetric with
 * `storage.ts:parseMediaCol`.
 */
export function toLiveFrameRow(m: LiveFrameMedia) {
  return {
    storage_key: m.storageKey,
    signed_url: m.signedUrl,
    signed_expires_at: m.signedExpiresAt,
    content_type: m.contentType,
    kind: m.kind,
    source_url: m.sourceUrl,
  };
}

/** Type assertion helper for callers that pass into `setToolActivityMedia`. */
export function toToolActivityMedia(m: LiveFrameMedia): ToolActivityMedia {
  return {
    storageKey: m.storageKey,
    signedUrl: m.signedUrl,
    signedExpiresAt: m.signedExpiresAt,
    contentType: m.contentType,
    kind: m.kind,
    sourceUrl: m.sourceUrl,
  };
}

export const __TEST_ONLY__ = { LIVE_FRAME_TTL_SEC };

/**
 * Phase 2 (R-luca-computer-ui) — agent_browser screenshot persistence.
 *
 * Wraps `workspace-storage.saveAssetAndSign` to upload a base64 JPEG
 * screenshot captured by Stagehand into the private `luca-workspace`
 * Supabase bucket and return a short-lived signed URL ready to attach
 * to a tool_activity_log row.
 *
 * BRO1 R431 must-fixes (Phase 2):
 *   1. Private bucket + signed URL TTL = 1h (NOT public; GDPR/CCPA — BOSS California).
 *      Screenshots may contain emails / session IDs / customer names.
 *   2. Blocklist-pre-upload: if `final_url` resolves to an internal /
 *      cloud-metadata host, we MUST NOT upload — defends against an attacker
 *      tricking Luca into pushing private network responses to our bucket.
 *   3. Runtime DDL on tool_activity_log (handled in storage.ts:ensureToolActivityLog,
 *      not Drizzle migration). This module just writes — it doesn't own DDL.
 *
 * Best-effort: upload failures must never break agent_browser itself.
 */

import { saveAssetAndSign, workspaceEnabled } from "../../workspace-storage";
import { isHostBlocked } from "./agent-browser-blocklist";
import logger from "../../logger";

/** Hard-coded TTL — keep in sync with parseMediaCol re-sign threshold. */
const SCREENSHOT_TTL_SEC = 60 * 60; // 1 hour

export interface PersistedScreenshot {
  storageKey: string;
  signedUrl: string;
  signedExpiresAt: number;
  contentType: string;
  kind: "screenshot";
  sourceUrl: string | null;
}

/**
 * Decide whether the browsed final URL is safe to back to bucket.
 * Returns false (== block) if:
 *   - URL is malformed
 *   - hostname matches isHostBlocked (internal / cloud-metadata)
 */
export function isUrlSafeForUpload(finalUrl: string | undefined | null): boolean {
  if (!finalUrl) return true; // unknown final_url — let upload proceed (rare; no host to leak)
  let host: string;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    // Malformed URL: refuse to upload to be conservative.
    return false;
  }
  if (!host) return false;
  return !isHostBlocked(host);
}

/**
 * Persist a base64 JPEG screenshot from agent_browser into the private
 * workspace bucket. Returns null on any failure or when blocked / disabled.
 */
export async function persistAgentBrowserScreenshot(args: {
  userId: number;
  agentId: number;
  sessionId: string;
  screenshotB64: string;
  finalUrl?: string | null;
}): Promise<PersistedScreenshot | null> {
  const { userId, agentId, sessionId, screenshotB64, finalUrl } = args;

  if (!workspaceEnabled) {
    logger.warn(
      { source: "luca_agent_browser", op: "screenshot_persist_skipped", reason: "workspace_disabled" },
      "agent_browser: workspace storage not configured, skipping screenshot persist",
    );
    return null;
  }

  if (!screenshotB64 || typeof screenshotB64 !== "string") return null;

  // BRO1 R431 must-fix #2 — blocklist-pre-upload.
  if (!isUrlSafeForUpload(finalUrl ?? null)) {
    logger.warn(
      {
        source: "luca_agent_browser",
        op: "screenshot_persist_blocked",
        reason: "host_blocked_or_malformed",
        finalUrl,
      },
      "agent_browser: refusing to upload screenshot for blocked host",
    );
    return null;
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(screenshotB64, "base64");
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  // Path: <userId>/<agentId>/agent_browser/<sessionId>.jpg
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "session";
  const relPath = `agent_browser/${Date.now()}_${safeSession}.jpg`;

  try {
    const { key, url } = await saveAssetAndSign(userId, agentId, relPath, buf, {
      contentType: "image/jpeg",
      expiresSec: SCREENSHOT_TTL_SEC,
    });
    return {
      storageKey: key,
      signedUrl: url,
      signedExpiresAt: Date.now() + SCREENSHOT_TTL_SEC * 1000,
      contentType: "image/jpeg",
      kind: "screenshot",
      sourceUrl: finalUrl ?? null,
    };
  } catch (e: any) {
    logger.warn(
      {
        source: "luca_agent_browser",
        op: "screenshot_persist_failed",
        err: e?.message || String(e),
      },
      "agent_browser: screenshot upload failed (non-fatal)",
    );
    return null;
  }
}

/**
 * Convert PersistedScreenshot → snake_case JSONB row format used in the
 * tool_activity_log.media_urls column. Symmetric with
 * storage.ts:parseMediaCol.
 */
export function toMediaRow(p: PersistedScreenshot) {
  return {
    storage_key: p.storageKey,
    signed_url: p.signedUrl,
    signed_expires_at: p.signedExpiresAt,
    content_type: p.contentType,
    kind: p.kind,
    source_url: p.sourceUrl,
  };
}

export const __TEST_ONLY__ = { SCREENSHOT_TTL_SEC };

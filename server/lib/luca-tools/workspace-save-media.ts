/**
 * Phase 3 (R-luca-computer-ui): persist a freshly-saved workspace file as a
 * `ToolActivityMedia` row so the activity timeline can render an inline
 * thumbnail (icon-only for now) and open it in the FileLightbox.
 *
 * Unlike `agent-browser-screenshot.persistAgentBrowserScreenshot`, this
 * helper does NOT upload — `workspace_save` already wrote the bytes via
 * `saveAssetAndSign`. We just produce a `ToolActivityMedia` shape from the
 * known key + content-type + size.
 *
 * Security:
 *   - `ALLOWED_MIME` allowlist enforced HARD at the deliberation case. SVG
 *     intentionally excluded (XSS vector through inline <script>). HTML/exec
 *     rejected.
 *   - `FILE_TTL_SEC = 1h` matches `agent-browser-screenshot` (R431 §2.1).
 *   - Best-effort throughout — failures must never break workspace_save.
 */

import logger from "../../logger";
import { getSignedUrl, workspaceEnabled } from "../../workspace-storage";
import type { ToolActivityMedia } from "../../storage";

// 1h signed URL TTL — re-signed by `refreshExpiringMediaForActivity` when
// <5min from expiry on every fetch (BRO1 R431 §2.1).
const FILE_TTL_SEC = 60 * 60;

/**
 * MIME allowlist for `workspace_save`. Reject everything else with a clear
 * error so Luca learns the constraint.
 *
 * Excluded on purpose:
 *   - `image/svg+xml` (XSS via <script>)
 *   - `text/html` / `application/xhtml+xml` (XSS)
 *   - `application/javascript` / `application/ecmascript` (XSS)
 *   - any executable / archive (.zip, .tar, .gz, .exe, .dmg)
 *
 * Allowed:
 *   - PDF + JSON
 *   - text/* (plain, markdown, csv, x-* like x-python, x-typescript)
 *   - safe images (png, jpeg, gif, webp)
 */
export const ALLOWED_MIME =
  /^(application\/(pdf|json)|text\/(plain|markdown|csv|x-[a-z0-9._+-]+)|image\/(png|jpeg|jpg|gif|webp))$/i;

export interface PersistedWorkspaceFile {
  storageKey: string;
  signedUrl: string;
  signedExpiresAt: number;
  contentType: string;
  kind: "file" | "screenshot";
  sourceUrl: string | null;
  sizeBytes: number;
}

/**
 * Build a ToolActivityMedia entry for a file already written to the workspace
 * bucket. Returns `null` on any failure (best-effort).
 *
 * @param storageKey  Full bucket key (`<userId>/<agentId>/<path>`).
 * @param contentType MIME type \u2014 must already pass `ALLOWED_MIME` (caller
 *                    enforces; we don't double-check here so error messages
 *                    surface at the deliberation layer with a friendly
 *                    "contentType not allowed: …" string).
 * @param sizeBytes   Buffer length at write time. Required \u2014 the lightbox
 *                    relies on this for the PDF size gate.
 */
export async function persistWorkspaceSaveMedia(input: {
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  // For workspace_save the file IS the source — no external URL to surface.
  sourceUrl?: string | null;
}): Promise<PersistedWorkspaceFile | null> {
  if (!workspaceEnabled) return null;
  if (!input.storageKey || !input.contentType || !Number.isFinite(input.sizeBytes)) {
    return null;
  }
  try {
    const signedUrl = await getSignedUrl(input.storageKey, FILE_TTL_SEC);
    return {
      storageKey: input.storageKey,
      signedUrl,
      signedExpiresAt: Date.now() + FILE_TTL_SEC * 1000,
      contentType: input.contentType,
      kind: kindForContentType(input.contentType),
      sourceUrl: input.sourceUrl ?? null,
      sizeBytes: input.sizeBytes,
    };
  } catch (err: any) {
    logger.warn(
      { source: "workspace-save-media", err: err?.message || String(err) },
      "workspace_save: media re-sign failed (non-fatal)",
    );
    return null;
  }
}

/**
 * Map `contentType` \u2192 `ToolActivityMedia.kind`. Images stay as `screenshot`
 * (existing UI path). Everything else is `file` (FileLightbox in Phase 3).
 */
export function kindForContentType(ct: string): "screenshot" | "file" {
  return /^image\//i.test(ct) ? "screenshot" : "file";
}

/** Convert PersistedWorkspaceFile \u2192 snake_case JSONB row format. */
export function toWorkspaceMediaRow(p: PersistedWorkspaceFile) {
  return {
    storage_key: p.storageKey,
    signed_url: p.signedUrl,
    signed_expires_at: p.signedExpiresAt,
    content_type: p.contentType,
    kind: p.kind,
    source_url: p.sourceUrl,
    size_bytes: p.sizeBytes,
  };
}

export const __TEST_ONLY__ = { FILE_TTL_SEC };

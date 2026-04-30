/**
 * KIOKU™ Internal Jobs — Daily Attachment PII Cleanup
 *
 * PR-A.6 (R349). For every room_messages.attachments[] entry whose
 * `expires_at` is in the past and whose `storage_key` is still set, delete
 * the binary from Supabase Storage and patch the JSONB row to clear
 * storage_key + signed_url so:
 *   - downstream readers (asset-bytes-cache, deliberation history) skip
 *     vision blocks and fall back to the existing summary/transcription/
 *     extracted_text that we keep forever (textual memory survives;
 *     only the binary is purged).
 *   - markAttachmentExpired is idempotent — safe to re-run if a partial
 *     batch errored mid-loop.
 *
 * Telegram default retention = 90 days (TELEGRAM_PII_RETENTION_DAYS in
 * telegram-inbound.ts). Direct uploads with a null `expires_at` are kept
 * forever (PWA workspace assets, e.g. images Луке is supposed to remember
 * indefinitely).
 *
 * Schedule: daily at 04:00 UTC (between Pacific evening and morning so
 * the BOSS isn't watching when it runs). Single-replica via runWithClaim.
 *
 * Writes kioku_job_runs detail:
 *   { scanned, deleted, failed, skippedDisabled }
 */

import logger from "../../logger";
import { storage } from "../../storage";
import { deleteAssetByKey, workspaceEnabled } from "../../workspace-storage";

export const ASSET_CLEANUP_JOB_ID = "attachment-pii-cleanup";

/** Cap per run so a backlog never starves the tick loop or hits Supabase too hard. */
const MAX_PER_RUN = 500;

export interface AssetCleanupResult {
  scanned: number;
  deleted: number;
  failed: number;
  skippedDisabled: boolean;
}

/**
 * Single-shot cleanup. Exported for direct invocation in tests + an admin
 * route (so an operator can force a run without waiting until 04:00 UTC).
 */
export async function runAssetCleanup(
  now: number = Date.now(),
): Promise<AssetCleanupResult> {
  if (!workspaceEnabled) {
    logger.info(
      { component: "asset-cleanup" },
      "[asset-cleanup] workspace storage disabled — skipping",
    );
    return { scanned: 0, deleted: 0, failed: 0, skippedDisabled: true };
  }

  const expired = await storage.listExpiredAttachments(now);
  const toProcess = expired.slice(0, MAX_PER_RUN);
  let deleted = 0;
  let failed = 0;

  // Sequential — Supabase Storage delete is fast and we don't want to flood
  // the bucket-side connection pool. If MAX_PER_RUN ever climbs past 500
  // batch this with a small concurrency window.
  for (const { messageId, attachmentId, storageKey } of toProcess) {
    const ok = await deleteAssetByKey(storageKey);
    if (!ok) {
      failed++;
      logger.warn(
        { component: "asset-cleanup", messageId, attachmentId, storageKey },
        "[asset-cleanup] supabase delete failed — will retry next run",
      );
      continue;
    }
    try {
      await storage.markAttachmentExpired(messageId, attachmentId);
      deleted++;
    } catch (err: any) {
      failed++;
      logger.warn(
        {
          component: "asset-cleanup",
          messageId,
          attachmentId,
          err: err?.message || String(err),
        },
        "[asset-cleanup] markAttachmentExpired failed after delete",
      );
    }
  }

  logger.info(
    {
      component: "asset-cleanup",
      scanned: expired.length,
      processed: toProcess.length,
      deleted,
      failed,
    },
    "[asset-cleanup] run complete",
  );
  return { scanned: expired.length, deleted, failed, skippedDisabled: false };
}

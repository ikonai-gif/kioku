/**
 * PR-A.6 — In-memory LRU cache for attachment bytes.
 *
 * Why: deliberation needs to feed image bytes to Anthropic vision blocks for
 * the most-recent N turns. Refetching ~50KB-5MB of image bytes from Supabase
 * Storage on every iteration of a tool-use loop wastes wall-clock time and
 * costs egress, so we keep a process-local LRU keyed by Supabase storage_key.
 *
 * Bound: 50 MB total resident bytes. On insert, oldest entries are evicted
 * until the new entry fits. The map preserves insertion order, so we use it
 * directly as a recency list (delete + re-set on hit).
 *
 * This module also owns refreshSignedUrlIfNeeded (R349 caveat C1): when a
 * cached signed_url is approaching expiry (<5 min remaining), re-issue and
 * patch the value back into the room_messages.attachments JSONB slot for that
 * (messageId, attachmentId) so other readers benefit.
 */

import logger from "../logger";
import { getSignedUrl } from "../workspace-storage";
import { storage } from "../storage";
import type { AttachmentMeta } from "@shared/schema";

interface CacheEntry {
  mime: string;
  data: Buffer;
  fetched_at: number;
}

const cache = new Map<string, CacheEntry>();
let totalSize = 0;
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Internal helper exported for tests only. Resets cache + counters.
 * Must NOT be called from production code paths.
 */
export function __resetForTests(): void {
  cache.clear();
  totalSize = 0;
}

/** Internal helper exported for tests. */
export function __getCacheStateForTests(): { entries: number; totalBytes: number } {
  return { entries: cache.size, totalBytes: totalSize };
}

/**
 * Fetch attachment bytes by Supabase storage_key. On miss, issues a fresh
 * signed URL (1h) via getSignedUrl and downloads the body. On hit, the entry
 * is moved to the most-recent slot (LRU touch).
 *
 * Returns null on:
 *   - falsy storage_key (e.g. attachment whose PII window expired)
 *   - any network/Supabase error (logged as a warning, not thrown — callers
 *     fall back to a textual placeholder to keep deliberation flowing)
 */
export async function getAssetBytes(
  storageKey: string | null | undefined,
): Promise<{ mime: string; data: Buffer } | null> {
  if (!storageKey) return null;

  // LRU touch on hit
  const hit = cache.get(storageKey);
  if (hit) {
    cache.delete(storageKey);
    cache.set(storageKey, hit);
    return { mime: hit.mime, data: hit.data };
  }

  let signedUrl: string;
  try {
    signedUrl = await getSignedUrl(storageKey, 3600);
  } catch (err) {
    logger.warn({ err, storageKey }, "[asset-bytes-cache] getSignedUrl failed");
    return null;
  }

  let buf: Buffer;
  let mime: string;
  try {
    const res = await fetch(signedUrl);
    if (!res.ok) {
      logger.warn(
        { storageKey, status: res.status },
        "[asset-bytes-cache] supabase fetch non-2xx",
      );
      return null;
    }
    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
    mime = res.headers.get("content-type") || "application/octet-stream";
  } catch (err) {
    logger.warn({ err, storageKey }, "[asset-bytes-cache] supabase fetch threw");
    return null;
  }

  // Single object larger than the whole cache: don't store it (would evict
  // everything for one entry), but still return it to the caller.
  if (buf.length > MAX_BYTES) {
    logger.warn(
      { storageKey, sizeBytes: buf.length, maxBytes: MAX_BYTES },
      "[asset-bytes-cache] object exceeds cache budget, returning without storing",
    );
    return { mime, data: buf };
  }

  // Evict oldest until the new entry fits.
  while (totalSize + buf.length > MAX_BYTES && cache.size > 0) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const old = cache.get(oldestKey);
    if (old) totalSize -= old.data.length;
    cache.delete(oldestKey);
  }

  cache.set(storageKey, { mime, data: buf, fetched_at: Date.now() });
  totalSize += buf.length;
  return { mime, data: buf };
}

const SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min
const SIGNED_URL_TTL_SEC = 3600;                    // 1h

/**
 * Caveat C1 — keep room_messages.attachments[].signed_url fresh.
 *
 * If the attachment's signed_url still has at least 5 minutes of life,
 * return it as-is. Otherwise issue a new 1h signed URL via Supabase and
 * patch it (plus its expiry) back into the JSONB row through
 * storage.patchAttachment so concurrent readers stop re-issuing.
 *
 * Returns the URL the caller should use right now.
 */
export async function refreshSignedUrlIfNeeded(
  messageId: number,
  attachmentId: string,
  attachment: AttachmentMeta,
): Promise<string | null> {
  if (!attachment.storage_key) return null;
  const now = Date.now();
  if (
    attachment.signed_url &&
    attachment.signed_url_expires_at > now + SIGNED_URL_REFRESH_BUFFER_MS
  ) {
    return attachment.signed_url;
  }

  let newUrl: string;
  try {
    newUrl = await getSignedUrl(attachment.storage_key, SIGNED_URL_TTL_SEC);
  } catch (err) {
    logger.warn({ err, storageKey: attachment.storage_key }, "[asset-bytes-cache] refresh failed");
    return attachment.signed_url ?? null;
  }
  const newExpiresAt = now + SIGNED_URL_TTL_SEC * 1000;

  try {
    await storage.patchAttachment(messageId, attachmentId, {
      signed_url: newUrl,
      signed_url_expires_at: newExpiresAt,
    });
  } catch (err) {
    // Patch failure is non-fatal: caller still gets a working URL, the next
    // reader will just refresh again.
    logger.warn({ err, messageId, attachmentId }, "[asset-bytes-cache] patchAttachment failed");
  }

  return newUrl;
}

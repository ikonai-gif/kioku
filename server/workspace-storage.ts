/**
 * Luca persistent workspace — Supabase Storage backend.
 *
 * Stores generated media assets (images, video, audio, music, subtitled
 * videos, final episodes) in a private bucket. Returns signed URLs with
 * configurable expiry so Luca always has a stable link to pass around,
 * without exposing content publicly.
 *
 * This module uses the storage HTTP API directly (no @supabase/supabase-js
 * dependency) so we stay thin and don't drag in another package.
 *
 * Workspace layout:
 *   <userId>/<agentId>/<subpath>
 * Examples:
 *   10/16/auto/1776653648123_image.png         (auto-saved generated asset)
 *   10/16/episodes/ikonbai-confidential/ep01/scene1.mp4
 *   10/16/workspace/notes/script-draft.txt     (free-form Luca workspace)
 */

import logger from "./logger";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "luca-workspace";

export const workspaceEnabled = !!(SUPABASE_URL && SUPABASE_KEY);

/** Derive a content-type from file extension (best-effort). */
function contentTypeFor(path: string): string {
  const ext = path.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
    txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv",
    pdf: "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}

/** Safe path join — strips leading slashes and duplicate separators. */
function buildKey(userId: number, agentId: number, relPath: string): string {
  const clean = relPath.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return `${userId}/${agentId}/${clean}`;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra,
  };
}

/**
 * Upload a buffer to the workspace bucket.
 * Returns the storage key (stable identifier) on success.
 */
export async function saveAsset(
  userId: number,
  agentId: number,
  relPath: string,
  body: Buffer | Uint8Array,
  opts: { contentType?: string; upsert?: boolean } = {}
): Promise<string> {
  if (!workspaceEnabled) throw new Error("Workspace storage not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)");
  const key = buildKey(userId, agentId, relPath);
  const ct = opts.contentType || contentTypeFor(relPath);
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`,
    {
      method: "POST",
      headers: authHeaders({
        "Content-Type": ct,
        "x-upsert": opts.upsert === false ? "false" : "true",
      }),
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Storage upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return key;
}

/**
 * Generate a signed URL for a stored asset.
 * expiresSec defaults to 7 days — enough for the user to download / share
 * a generated episode, short enough that a leaked link eventually dies.
 */
export async function getSignedUrl(
  key: string,
  expiresSec: number = 7 * 24 * 60 * 60
): Promise<string> {
  if (!workspaceEnabled) throw new Error("Workspace storage not configured");
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encodeURI(key)}`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: expiresSec }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Signed URL failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const { signedURL } = (await res.json()) as { signedURL: string };
  // signedURL comes back as `/object/sign/...` — prefix with origin + /storage/v1
  return `${SUPABASE_URL}/storage/v1${signedURL}`;
}

/** Upload + immediate signed URL, one call. */
export async function saveAssetAndSign(
  userId: number,
  agentId: number,
  relPath: string,
  body: Buffer | Uint8Array,
  opts: { contentType?: string; expiresSec?: number; upsert?: boolean } = {}
): Promise<{ key: string; url: string }> {
  const key = await saveAsset(userId, agentId, relPath, body, opts);
  const url = await getSignedUrl(key, opts.expiresSec);
  return { key, url };
}

/**
 * Accept either a data URI (data:image/png;base64,...) OR a remote URL
 * and mirror it to the workspace, returning a stable signed URL.
 *
 * If the input is already a supabase signed URL to our own bucket, it's
 * returned as-is (idempotent).
 */
export async function persistAssetSource(
  userId: number,
  agentId: number,
  source: string,
  suggestedPath: string,
  opts: { expiresSec?: number } = {}
): Promise<{ key: string; url: string }> {
  // Idempotency: already a signed URL from our own bucket
  if (source.includes(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/`)) {
    // Extract key, re-sign with fresh expiry
    const m = source.match(new RegExp(`/${BUCKET}/([^?]+)`));
    if (m) {
      const key = decodeURIComponent(m[1]);
      const url = await getSignedUrl(key, opts.expiresSec);
      return { key, url };
    }
  }

  let body: Buffer;
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    if (comma < 0) throw new Error("Malformed data URI");
    body = Buffer.from(source.slice(comma + 1), "base64");
  } else if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch source failed (${res.status}) ${source.slice(0, 80)}`);
    const ab = await res.arrayBuffer();
    body = Buffer.from(ab);
  } else {
    throw new Error("Unsupported asset source (expected data: URI or http(s):// URL)");
  }

  return await saveAssetAndSign(userId, agentId, suggestedPath, body, {
    expiresSec: opts.expiresSec,
  });
}

/** List entries in a workspace folder. Returns simplified name+size records. */
export async function listWorkspace(
  userId: number,
  agentId: number,
  prefix: string = ""
): Promise<Array<{ name: string; size: number; updated_at: string }>> {
  if (!workspaceEnabled) throw new Error("Workspace storage not configured");
  const keyPrefix = buildKey(userId, agentId, prefix);
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix: keyPrefix, limit: 200, sortBy: { column: "updated_at", order: "desc" } }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`List failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const items = (await res.json()) as Array<any>;
  return items.map((i) => ({
    name: i.name,
    size: i.metadata?.size ?? 0,
    updated_at: i.updated_at || i.created_at || "",
  }));
}

/** Delete a single asset. */
export async function deleteAsset(userId: number, agentId: number, relPath: string): Promise<void> {
  if (!workspaceEnabled) return;
  const key = buildKey(userId, agentId, relPath);
  await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURI(key)}`,
    { method: "DELETE", headers: authHeaders() }
  ).catch((e) => logger.warn({ source: "workspace-storage", err: String(e) }, "delete failed"));
}

/** Quick self-test: checks env + bucket reachability without mutating anything. */
export async function workspaceHealth(): Promise<{ configured: boolean; bucket: string; ok: boolean; error?: string }> {
  if (!workspaceEnabled) return { configured: false, bucket: BUCKET, ok: false, error: "env vars missing" };
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: authHeaders() });
    if (!res.ok) return { configured: true, bucket: BUCKET, ok: false, error: `bucket check ${res.status}` };
    return { configured: true, bucket: BUCKET, ok: true };
  } catch (e: any) {
    return { configured: true, bucket: BUCKET, ok: false, error: e?.message || String(e) };
  }
}

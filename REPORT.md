# `workspace_save` Storage Backend — Diagnostic Report

**Date:** 2026-05-10
**Trigger:** After PR #140 reclassified `workspace_save` to `LOW_STAKES_WRITE`, writes now fail with `403 Unauthorized, Invalid Compact JWS`.
**Conclusion (TL;DR):** `workspace_save` writes to **Supabase Storage**, not AWS S3. The S3 env vars BOSS configured (`LUCA_S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`) are **unrelated to this tool** — they exist for `analyze_image`'s SSRF allow-list, not for uploads. The actual cause of the 403 is a missing or malformed `SUPABASE_SERVICE_ROLE_KEY`.

---

## 1. Where `workspace_save` lives

The deliberation loop handles the tool case at `server/deliberation.ts:5720–5780`. It calls `saveAssetAndSign(userId, agentId, path, buf, { contentType })` from `server/workspace-storage.ts`.

```5720:5734:server/deliberation.ts
      case "workspace_save": {
        if (!workspaceEnabled) return "Workspace not configured on this server.";
        const path = typeof toolInput.path === "string" ? toolInput.path.replace(/^\/+/, "") : "";
        const content = typeof toolInput.content === "string" ? toolInput.content : "";
        const encoding = toolInput.encoding === "base64" ? "base64" : "utf8";
        const contentType = typeof toolInput.content_type === "string" ? toolInput.content_type : undefined;
        if (!path) return "workspace_save: 'path' is required and cannot be empty or absolute.";
        // Phase 3 (R-luca-computer-ui, BRO1 R434 must-fix #2): HARD MIME allowlist.
        // Reject html/svg/exec to prevent XSS in the FileLightbox preview.
        if (contentType && !WORKSPACE_SAVE_ALLOWED_MIME.test(contentType)) {
          return `workspace_save: contentType not allowed: ${contentType}. Allowed: pdf/json/text/*\u00a0(no html, svg, executable)/safe images (png, jpeg, gif, webp).`;
        }
        try {
          const buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
          const { key, url } = await saveAssetAndSign(userId, agentId, path, buf, { contentType });
```

## 2. Storage backend — Supabase Storage HTTP API

`server/workspace-storage.ts` is a thin Supabase Storage HTTP client. **No** AWS SDK / S3 client is involved.

```20:26:server/workspace-storage.ts
import logger from "./logger";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET = "luca-workspace";

export const workspaceEnabled = !!(SUPABASE_URL && SUPABASE_KEY);
```

The actual upload (`saveAsset` → called by `saveAssetAndSign`) POSTs to `${SUPABASE_URL}/storage/v1/object/{BUCKET}/{key}` with the service-role key as a Bearer token:

```47:85:server/workspace-storage.ts
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
```

Key facts from the source:

| Aspect              | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Backend             | Supabase Storage (`/storage/v1/object/...` REST endpoints)                           |
| SDK                 | None — raw `fetch` (`server/workspace-storage.ts` opening doc-comment lines 9–10)    |
| Bucket name         | Hard-coded constant `"luca-workspace"` (line 24)                                     |
| Auth                | `apikey:` + `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>` — both are the **JWT** service-role key |
| Required env vars   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                          |
| Enable flag         | `workspaceEnabled = !!(SUPABASE_URL && SUPABASE_KEY)` — both must be set             |

No `@supabase/supabase-js` and no `@aws-sdk/*` dependencies are present in `package.json`. Confirmed:

```bash
$ grep -E '("@aws-sdk|"@supabase)' package.json
# (no matches)
```

## 3. What `LUCA_S3_BUCKET` is actually for

The S3 env vars BOSS configured are read by an unrelated tool, `analyze_image` — they are an **SSRF allow-list of image source origins**, not an upload target.

```14:25:server/lib/luca-tools/analyze-image.ts
 * SF4 — "regional S3 whitelist":
 *   `LUCA_S3_BUCKET` + `AWS_REGION` env vars define the ONLY allowed origin
 *   for image URLs. All four URL shapes for the same bucket-region tuple are
 *   accepted (s3://, virtual-hosted https with/without region, path-style
 *   https). Everything else is rejected BEFORE any network call — this
 *   prevents SSRF against internal endpoints and keeps the attack surface
 *   to a single well-known storage origin that Luca itself uses for
 *   generate_image output.
 *
 *   If `LUCA_S3_BUCKET` is unset at tool-invocation time, SF4 fails closed
 *   (reject all URLs). This is intentional: a mis-configured prod env should
 *   NOT silently allow arbitrary URL fetches.
 */
```

Reinforced in the env inventory:

```27:32:server/lib/luca/env.ts
  /** Private S3 bucket, presigned-only. For plots, caches, embeddings. */
  LUCA_S3_BUCKET: string | null;

  /** AWS region for SF4 regional S3 URL whitelist in analyze_image. */
  AWS_REGION: string | null;
```

`LUCA_S3_BUCKET` is **never** referenced by `workspace-storage.ts`, `workspace-save-media.ts`, or the `workspace_save` case in `deliberation.ts`. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are not referenced anywhere in the server code (no AWS SDK importer exists to consume them).

## 4. Why the error is "Invalid Compact JWS"

"Compact JWS" is the dot-separated JWT serialization (`header.payload.signature`). Supabase Storage gateway emits exactly this 403 message (`{"statusCode":"403","error":"Unauthorized","message":"Invalid Compact JWS"}`) when the value sent in `Authorization: Bearer …` cannot be parsed as a JWS / JWT.

For this code path that means **`process.env.SUPABASE_SERVICE_ROLE_KEY` is set (otherwise `workspaceEnabled` would be false and the tool would short-circuit on the `Workspace not configured` line at `deliberation.ts:5721`) but its value is not a valid Supabase service-role JWT.**

Most common causes:

1. The variable was set to a placeholder, a project ref, or the bucket name — anything that is not `eyJ...`-shaped.
2. It was set to the Supabase **`anon`** key for a different project, or to the dashboard "publishable" key — those *are* JWTs but don't authorize storage writes; however that scenario typically returns `403 new row violates row-level security` / `401 missing Bearer`, not `Invalid Compact JWS`. So the actual symptom points at #1 or #3.
3. It was pasted with surrounding whitespace, line breaks, or wrapping quotes that broke the JWT format (very common when copying through Railway's dashboard).
4. It was truncated (e.g. shell variable expansion stopped at a `$` inside the key).

The error is 100% coming from Supabase, not from AWS. AWS S3 returns errors like `<Code>SignatureDoesNotMatch</Code>` or `<Code>InvalidAccessKeyId</Code>`, never "Invalid Compact JWS".

## 5. Mismatch summary

| What BOSS configured on Railway | What the code actually needs              | Used by                                  |
| ------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `LUCA_S3_BUCKET=ikonbai-luca-storage` | (unused for workspace_save) — used as `analyze_image` SSRF allow-list | `server/lib/luca-tools/analyze-image.ts` |
| `AWS_REGION=us-west-2`          | (unused for workspace_save) — same SSRF allow-list | `server/lib/luca-tools/analyze-image.ts` |
| `AWS_ACCESS_KEY_ID`             | **not referenced anywhere in `server/`**  | nothing                                  |
| `AWS_SECRET_ACCESS_KEY`         | **not referenced anywhere in `server/`**  | nothing                                  |
| _(missing or malformed)_ `SUPABASE_URL` | **required** — Supabase project URL | `server/workspace-storage.ts:22`         |
| _(missing or malformed)_ `SUPABASE_SERVICE_ROLE_KEY` | **required** — Supabase service-role JWT (the long `eyJ…` value) | `server/workspace-storage.ts:23`         |

Net effect: `workspace_save` reached the Supabase upload step (so `SUPABASE_URL` *and* a non-empty `SUPABASE_SERVICE_ROLE_KEY` are present in the environment), but the service-role key value is not a valid JWT, so Supabase's gateway rejects it with `403 Invalid Compact JWS` **before** ever consulting the bucket or RLS policy.

## 6. Recommended fix (NOT applied — diagnostic only)

Two parts, in priority order:

### A. Configure the **correct** env vars in Railway (unblocks production)

1. Open the Supabase project that owns the `luca-workspace` bucket.
2. Project Settings → API → copy:
   - **Project URL** → set `SUPABASE_URL` (e.g. `https://abcd1234.supabase.co`, no trailing slash, no quotes).
   - **`service_role` secret** (the long `eyJhbGciOi…` JWT, *not* `anon`, *not* `publishable`) → set `SUPABASE_SERVICE_ROLE_KEY`. Verify in Railway's UI that the value starts with `eyJ` and contains exactly two `.` separators; trim whitespace.
3. Verify the bucket `luca-workspace` exists and is *private* (signed-URL only).
4. Redeploy the Railway service so the new env vars are picked up.
5. Sanity-check by hitting the existing health endpoint that calls `workspaceHealth()` (look for the `/api/health/...` route that wraps `server/workspace-storage.ts:326–335`) and confirm it returns `{ ok: true }`.
6. Optionally remove the AWS_* vars from Railway — they are dead weight unless `analyze_image` is being enabled at the same time, in which case `LUCA_S3_BUCKET` + `AWS_REGION` *are* useful (but `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are still unused by this codebase).

### B. Improve the developer experience (follow-up PR — optional)

The current symptom is hard to debug because the runtime error surface is "Workspace save failed: Storage upload failed (403): {Invalid Compact JWS …}" with no hint about which env var is wrong. Suggested non-blocking improvements for a later PR:

- In `workspaceEnabled` (`server/workspace-storage.ts:26`), also check that `SUPABASE_SERVICE_ROLE_KEY` *looks* like a JWT (`/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`). Log a one-shot warning at startup if it fails the shape check.
- When `saveAsset` gets a 401/403 from Supabase, prepend a hint like `"(check SUPABASE_SERVICE_ROLE_KEY)"` to the thrown error so the message Luca sees in the workspace tab is actionable.
- Update `docs/` (or whatever the env reference doc is — `docs/env.md` if it exists) to clarify that `LUCA_S3_BUCKET` is **only** for `analyze_image` SSRF whitelisting and has nothing to do with workspace storage.

## 7. Confidence

**High.** The code path is short and self-contained:
- `deliberation.ts:5720` → `saveAssetAndSign` → `saveAsset` → `fetch(${SUPABASE_URL}/storage/v1/...)` with `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`.
- No other storage SDK is imported anywhere in the repo (verified by grepping the `package.json` and the full `server/` tree for `@aws-sdk` and `@supabase`).
- The error string "Invalid Compact JWS" is a Supabase / `jose` library signature that AWS S3 cannot produce.

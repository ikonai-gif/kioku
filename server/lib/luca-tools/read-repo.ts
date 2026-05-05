/**
 * R466 — luca_read_repo (Phase 2 of Luca-autonomy plan).
 *
 * Read-only file fetch from the KIOKU repo over the GitHub Contents API.
 * Pure builder + handler split:
 *   - validateRepoPath(path)        — pure path validator (no I/O).
 *   - fetchRepoFile(path, opts)     — performs the GET via fetch(), returns
 *     {status, content?, sha?, size?, error?, error_detail?}. Handler is
 *     called by the dispatcher in server/deliberation.ts main switch.
 *
 * Safety:
 *   1. Allowlist of path prefixes. Only paths matching one of
 *      LUCA_READ_REPO_PATH_ALLOW (default: 'server/', 'shared/', 'tests/',
 *      'migrations/', 'README.md', 'package.json', 'tsconfig.json',
 *      'drizzle.config.ts') are admissible. Configurable via env, comma-
 *      separated. Trailing slash means "any file under that directory".
 *   2. Hard denylist of secret-bearing paths even if allowlist matches:
 *      '.env', '.env.', 'secrets/', 'credentials/', '.npmrc' (any
 *      occurrence in the path string, not just prefix).
 *   3. No path traversal. '..' and absolute paths are rejected upfront.
 *   4. File-size cap (default 256 KiB). The Contents API returns base64-
 *      encoded content + a `size` field; we reject before decoding when
 *      size > cap. Defends against accidentally pulling huge generated
 *      bundles into the LLM context.
 *   5. Owner+repo are env-locked. LUCA_READ_REPO_OWNER + LUCA_READ_REPO_REPO
 *      (defaults: 'ikonai-gif' + 'kioku'). Tool input only carries `path`
 *      and optional `ref`. Luca CANNOT pivot to a different repo at call
 *      time — that's a hard env boundary.
 *   6. Token: GITHUB_LUCA_READ_TOKEN (granular fine-grained PAT, repo
 *      Contents:read on KIOKU only). NEVER exposed in returned data,
 *      logs, or audit. If unset, tool returns {error:'not_configured'}.
 *   7. Rate-limited at the dispatcher (20/h + 10/min per agent).
 *
 * Returns to Luca:
 *   ok:      {status:'ok', path, ref, sha, size_bytes, content (UTF-8)}
 *   error:   {status:'error', error: <code>, error_detail?: <short msg>}
 *
 * Audit: writes via the same recordLucaAudit() path as other luca_* tools.
 * input_hash includes path + ref (no token).
 */

export type ReadRepoErrorCode =
  | "not_configured"
  | "invalid_path"
  | "path_not_allowed"
  | "path_denied"
  | "ref_invalid"
  | "too_large"
  | "not_a_file"
  | "binary_unsupported"
  | "github_unauthorized"
  | "github_not_found"
  | "github_rate_limited"
  | "github_error"
  | "fetch_failed";

export interface ReadRepoResultOk {
  status: "ok";
  path: string;
  ref: string;
  sha: string;
  size_bytes: number;
  content: string;
}

export interface ReadRepoResultErr {
  status: "error";
  error: ReadRepoErrorCode;
  error_detail?: string;
}

export type ReadRepoResult = ReadRepoResultOk | ReadRepoResultErr;

/**
 * Hard-denied substrings — even when an allowlist prefix matches, these
 * occurrences in the path string make the call fail closed. Lowercased
 * before comparison so 'Secrets/' and 'SECRETS/' are both blocked.
 */
const DEFAULT_DENY_SUBSTRINGS = [
  ".env",
  "secrets/",
  "credentials/",
  ".npmrc",
  "id_rsa",
  "id_ed25519",
  "/.ssh/",
  "private_key",
];

/**
 * Default allowed path prefixes. A prefix ending with '/' means "any
 * descendant of this directory". A prefix not ending with '/' must be
 * an exact path match (e.g. 'README.md').
 */
const DEFAULT_ALLOW_PREFIXES = [
  "server/",
  "shared/",
  "tests/",
  "migrations/",
  "client/",
  "scripts/",
  "script/",
  "README.md",
  "package.json",
  "tsconfig.json",
  "drizzle.config.ts",
  "vitest.config.ts",
  "vite.config.ts",
  "Dockerfile",
];

/**
 * Read & parse the env-configured allowlist. Comma-separated, trimmed.
 * Empty / whitespace-only returns the defaults. Always lowercased for
 * matching (paths are case-sensitive on disk but for the small allowlist
 * we use, lowercase comparison is fine and avoids 'Server/' bypass).
 *
 * NOTE: we keep both allow + deny case-INSENSITIVE for safety. GitHub
 * paths are case-sensitive, but enforcing case-insensitive *match* means
 * an attacker can't bypass deny via uppercasing.
 */
export function readAllowPrefixes(envValue?: string | null): string[] {
  const v = envValue ?? "";
  const trimmed = v.trim();
  if (!trimmed) return [...DEFAULT_ALLOW_PREFIXES];
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readDenySubstrings(envValue?: string | null): string[] {
  const v = envValue ?? "";
  const trimmed = v.trim();
  if (!trimmed) return [...DEFAULT_DENY_SUBSTRINGS];
  // Env override REPLACES defaults — admin who sets this opts into full
  // responsibility for the deny list. Document in PR description.
  return trimmed
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Pure validator. Returns null on success, or an error code. Performs:
 *   1. Type / shape checks (non-empty string, ≤512 chars, no NUL bytes).
 *   2. Reject absolute paths and any '..' segment (path traversal guard).
 *   3. Reject leading slash, double slashes, backslashes.
 *   4. Reject if any deny substring appears (case-insensitive).
 *   5. Reject unless at least one allow prefix matches.
 */
export function validateRepoPath(
  path: string,
  opts?: { allowPrefixes?: string[]; denySubstrings?: string[] },
): { ok: true } | { ok: false; error: ReadRepoErrorCode } {
  if (typeof path !== "string") return { ok: false, error: "invalid_path" };
  if (path.length === 0 || path.length > 512) return { ok: false, error: "invalid_path" };
  if (path.includes("\0")) return { ok: false, error: "invalid_path" };
  if (path.startsWith("/")) return { ok: false, error: "invalid_path" };
  if (path.includes("\\")) return { ok: false, error: "invalid_path" };
  if (path.includes("//")) return { ok: false, error: "invalid_path" };
  // path-traversal: any '..' as a SEGMENT (not as a substring of a
  // legitimate filename like 'foo..bar.ts'). Split on '/' and check each.
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") return { ok: false, error: "invalid_path" };
    if (seg.length === 0) return { ok: false, error: "invalid_path" };
  }

  const lowerPath = path.toLowerCase();
  const denyList = opts?.denySubstrings ?? DEFAULT_DENY_SUBSTRINGS;
  for (const deny of denyList) {
    if (lowerPath.includes(deny.toLowerCase())) {
      return { ok: false, error: "path_denied" };
    }
  }

  const allowList = opts?.allowPrefixes ?? DEFAULT_ALLOW_PREFIXES;
  let allowed = false;
  for (const prefix of allowList) {
    if (prefix.endsWith("/")) {
      // Directory prefix.
      if (path.startsWith(prefix)) { allowed = true; break; }
    } else {
      // Exact-file allowlist entry.
      if (path === prefix) { allowed = true; break; }
    }
  }
  if (!allowed) return { ok: false, error: "path_not_allowed" };

  return { ok: true };
}

/**
 * Validates the optional `ref` (branch / tag / commit sha). Allows
 * alphanumerics, dot, dash, underscore, slash. Length ≤200. Empty/null
 * means "use default branch" — caller passes undefined to GitHub.
 */
export function validateRef(ref: string | undefined | null): { ok: true } | { ok: false; error: ReadRepoErrorCode } {
  if (ref === undefined || ref === null || ref === "") return { ok: true };
  if (typeof ref !== "string") return { ok: false, error: "ref_invalid" };
  if (ref.length > 200) return { ok: false, error: "ref_invalid" };
  if (!/^[A-Za-z0-9._\-/]+$/.test(ref)) return { ok: false, error: "ref_invalid" };
  return { ok: true };
}

export interface FetchRepoFileOpts {
  /** Branch / tag / commit. Optional — defaults to repo default branch. */
  ref?: string;
  /** Override owner — for testing. Production reads env. */
  owner?: string;
  repo?: string;
  /** PAT override. Production reads GITHUB_LUCA_READ_TOKEN. */
  token?: string;
  /** Max bytes accepted from the API `size` field. Default 256 KiB. */
  maxBytes?: number;
  /** Override fetch — for testing. */
  fetchImpl?: typeof fetch;
  /** Allow / deny lists — for testing. */
  allowPrefixes?: string[];
  denySubstrings?: string[];
}

/**
 * GitHub Contents API response shape (only fields we use). The full
 * shape includes encoding, html_url, etc. — we ignore those.
 */
interface GitHubContentsFile {
  type: "file" | "dir" | "symlink" | "submodule";
  encoding?: string;
  size: number;
  name: string;
  path: string;
  sha: string;
  content?: string;
}

/**
 * Main entry point. Fail-closed everywhere — any unexpected condition
 * resolves to a {status:'error', error:<code>} result rather than throwing.
 */
export async function fetchRepoFile(path: string, opts: FetchRepoFileOpts = {}): Promise<ReadRepoResult> {
  const allow = opts.allowPrefixes ?? readAllowPrefixes(process.env.LUCA_READ_REPO_PATH_ALLOW);
  const deny = opts.denySubstrings ?? readDenySubstrings(process.env.LUCA_READ_REPO_PATH_DENY);
  const validation = validateRepoPath(path, { allowPrefixes: allow, denySubstrings: deny });
  if (!validation.ok) return { status: "error", error: validation.error };

  const refValidation = validateRef(opts.ref);
  if (!refValidation.ok) return { status: "error", error: refValidation.error };

  const owner = opts.owner ?? process.env.LUCA_READ_REPO_OWNER ?? "ikonai-gif";
  const repo = opts.repo ?? process.env.LUCA_READ_REPO_REPO ?? "kioku";
  const token = opts.token ?? process.env.GITHUB_LUCA_READ_TOKEN ?? "";
  if (!token) return { status: "error", error: "not_configured" };

  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const f = opts.fetchImpl ?? fetch;

  // GitHub Contents API. encodeURIComponent() per-segment (NOT whole
  // path) so '/' separators stay intact. Path is already validated.
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const refQs = opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : "";
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${refQs}`;

  let resp: Response;
  try {
    resp = await f(url, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "kioku-luca-read-repo",
      },
    });
  } catch (e: any) {
    return {
      status: "error",
      error: "fetch_failed",
      error_detail: (e?.message ?? String(e)).slice(0, 200),
    };
  }

  if (resp.status === 401 || resp.status === 403) {
    // 403 may also be rate-limit. Check headers.
    const remaining = resp.headers.get("x-ratelimit-remaining");
    if (remaining === "0") return { status: "error", error: "github_rate_limited" };
    return { status: "error", error: "github_unauthorized", error_detail: `http_${resp.status}` };
  }
  if (resp.status === 404) {
    return { status: "error", error: "github_not_found" };
  }
  if (resp.status === 429) {
    return { status: "error", error: "github_rate_limited" };
  }
  if (resp.status >= 400) {
    return { status: "error", error: "github_error", error_detail: `http_${resp.status}` };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (e: any) {
    return {
      status: "error",
      error: "github_error",
      error_detail: `parse:${(e?.message ?? String(e)).slice(0, 100)}`,
    };
  }

  // The Contents API returns an array for directories, an object for
  // files. We only support files; reject directories cleanly.
  if (Array.isArray(body)) {
    return { status: "error", error: "not_a_file" };
  }
  if (!body || typeof body !== "object") {
    return { status: "error", error: "github_error", error_detail: "shape" };
  }

  const file = body as GitHubContentsFile;
  if (file.type !== "file") {
    return { status: "error", error: "not_a_file" };
  }
  if (typeof file.size !== "number" || file.size < 0) {
    return { status: "error", error: "github_error", error_detail: "size_missing" };
  }
  if (file.size > maxBytes) {
    return { status: "error", error: "too_large", error_detail: `${file.size}>${maxBytes}` };
  }
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    return { status: "error", error: "github_error", error_detail: "encoding" };
  }

  // Decode + UTF-8 sniff. If the buffer contains a NUL byte in the
  // first 8 KiB, treat as binary and refuse — pushing binary bytes into
  // an LLM context wastes tokens and may include compressed secrets.
  let buf: Buffer;
  try {
    buf = Buffer.from(file.content, "base64");
  } catch (e: any) {
    return { status: "error", error: "github_error", error_detail: "base64_decode" };
  }
  const sniffEnd = Math.min(buf.length, 8192);
  for (let i = 0; i < sniffEnd; i++) {
    if (buf[i] === 0) {
      return { status: "error", error: "binary_unsupported" };
    }
  }
  const content = buf.toString("utf8");

  return {
    status: "ok",
    path,
    ref: opts.ref ?? "default",
    sha: file.sha,
    size_bytes: file.size,
    content,
  };
}

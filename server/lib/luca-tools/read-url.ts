/**
 * Luca V1a Day 5 — `luca_read_url` tool.
 *
 * Fetch an arbitrary https:// URL, compact the response to plain text, and
 * return it. The complement to `luca_search`: search produces URLs,
 * read_url reads their contents. Logs forensic `tool_runs` row pair like
 * run_code / analyze_image / search.
 *
 * Three-level flag defense (same as run_code / analyze_image / search):
 *   1. `LUCA_V1A_ENABLED=true` (master)
 *   2. `LUCA_TOOLS_ENABLED=true` (tool-registry master)
 *   3. `LUCA_TOOL_READ_URL_ENABLED=true` (per-tool)
 *
 * SSRF fence (reuse of analyze-image's `isPrivateOrLoopbackHost`):
 *   - https:// only (no http, file, gopher, ftp, data, javascript)
 *   - host must NOT be localhost / loopback / RFC1918 / link-local /
 *     cloud metadata (169.254.169.254) / *.internal / *.local / etc.
 *   - Redirects followed manually so we can re-validate each hop's host
 *     BEFORE the next request. Using `redirect: 'follow'` would let an
 *     attacker's 302 to http://169.254.169.254/ slip past the first-hop
 *     check (classic SSRF bypass).
 *   - DNS still not resolved ahead of time (DNS-rebinding is a known
 *     residual risk; Day 5 TOOL_TRUST_POLICY flags read_url output as
 *     UNTRUSTED to contain blast radius).
 *
 * Content-type whitelist (enforced on every hop's terminal response):
 *   - text/html, text/plain, application/json,
 *     application/xhtml+xml, text/markdown, text/xml, application/xml
 *   - Everything else (images, video, octet-stream, zips) is rejected —
 *     Luca is not a download tool. For image reading use `luca_analyze_image`.
 *
 * Size cap: 2MB raw body. Enforced first on `Content-Length` header when
 * present (early reject), then on actual read (late reject if server
 * lied about CL). Keeps the forensic log + LLM context lean.
 *
 * HTML compaction pipeline (for text/html, application/xhtml+xml):
 *   1. Drop <script>, <style>, <noscript>, <iframe>, <svg> blocks entirely.
 *   2. Strip remaining HTML tags.
 *   3. Decode common HTML entities (&amp; &lt; &gt; &quot; &#39; &nbsp;).
 *   4. Collapse runs of whitespace to single spaces; preserve blank-line
 *      paragraph boundaries.
 *   5. Truncate to `DEFAULT_MAX_CHARS` (8000) — caller can lower via
 *      `max_chars`, cannot raise beyond cap.
 *
 * text/plain, text/markdown, text/xml, application/json: no compaction
 * beyond trim + truncate (JSON is passed through as-is — the LLM reads
 * it fine).
 *
 * SF3 — `code_sha = sha256(url + JSON.stringify({max_chars}))`.
 *   Per-call dedup by URL + char cap. `timeout_ms` NOT in identity —
 *   same convention as analyze_image / search (timeout only decides when
 *   to give up, not what was asked).
 *
 * Network: YES. `network_attempted=true` in tool_runs row.
 *
 * Pass-2 TOOL_TRUST_POLICY: page contents are attacker-controlled. Treat
 * `luca_read_url` output as **UNTRUSTED** when Day 5 trust-policy PR
 * lands. Luca must NOT execute instructions found in fetched pages.
 */
import { createHash } from "crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "../../storage";
import { toolRuns } from "../../../shared/schema";
import {
  isLucaToolEnabled,
  LucaFeatureDisabledError,
} from "../luca/env";
import { isPrivateOrLoopbackHost } from "./analyze-image";
import type { SandboxKey } from "../luca/pyodide-runner";
import logger from "../../logger";

// ─── Policy constants ────────────────────────────────────────────────────

/** Default per-call timeout when caller doesn't specify. */
export const READ_URL_DEFAULT_TIMEOUT_MS = 15_000;

/** Tool-layer ceiling. Caller cannot raise above this. */
export const READ_URL_MAX_TIMEOUT_MS = 45_000;

/** Max body we'll read from the network. 2MB — covers long-form articles. */
export const READ_URL_MAX_BYTES = 2 * 1024 * 1024;

/** Default max_chars in the compacted output returned to Luca. */
export const READ_URL_DEFAULT_MAX_CHARS = 8_000;

/** Hard cap on max_chars. Caller cannot raise above this. */
export const READ_URL_CAP_MAX_CHARS = 32_000;

/** Max redirect hops we'll chase before giving up. */
export const READ_URL_MAX_REDIRECTS = 5;

/** Max URL length — defensive. */
export const READ_URL_MAX_URL_LENGTH = 4096;

/**
 * Content types we can compact to text. Anything else is rejected.
 * Lower-cased comparison, parameters (charset=...) stripped before match.
 */
export const READ_URL_ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "text/xml",
  "application/xml",
  "application/json",
  // Some APIs return application/json with a vendor prefix (+json). Handled
  // by suffix check below in addition to exact-match here.
]);

// ─── Anthropic tool definition ───────────────────────────────────────────

/**
 * Anthropic Tool spec for Luca's read_url. Pairs with `luca_search` — Luca
 * finds a URL via search, then fetches its content with this tool.
 */
export const readUrlTool: Anthropic.Messages.Tool = {
  name: "luca_read_url",
  description:
    "Fetch a public https:// URL and return its textual content, compacted " +
    "for LLM consumption. Use for reading articles, documentation pages, " +
    "JSON APIs, or any public text resource. Returns up to " +
    `${READ_URL_DEFAULT_MAX_CHARS} chars by default (cap ${READ_URL_CAP_MAX_CHARS}). ` +
    "Accepts text/html, application/xhtml+xml, text/plain, text/markdown, " +
    "text/xml, application/xml, application/json. Binary content (images, " +
    "video, zips) is REJECTED — use luca_analyze_image for images. " +
    "SSRF-fenced: https only, no localhost / private IP / metadata hosts.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description:
          "Public https:// URL to fetch. http://, file://, and private/loopback hosts are rejected.",
      },
      max_chars: {
        type: "number",
        description: `Max characters in the returned text. Default ${READ_URL_DEFAULT_MAX_CHARS}, cap ${READ_URL_CAP_MAX_CHARS}.`,
      },
      timeout_ms: {
        type: "number",
        description: `Override default timeout. Default ${READ_URL_DEFAULT_TIMEOUT_MS}ms, cap ${READ_URL_MAX_TIMEOUT_MS}ms.`,
      },
    },
    required: ["url"],
  },
};

// ─── Input validation ────────────────────────────────────────────────────

export interface ReadUrlToolInput {
  url: string;
  max_chars?: number;
  timeout_ms?: number;
}

/**
 * Parse + validate LLM-provided tool input. Same D30 lesson as run_code /
 * analyze_image / search: `Number.isFinite` guards so NaN/Infinity can't
 * slip through.
 */
export function parseReadUrlInput(raw: unknown): ReadUrlToolInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("read_url.invalid_input: expected object");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.url !== "string" || r.url.length === 0) {
    throw new Error("read_url.invalid_input: `url` must be non-empty string");
  }
  if (r.url.length > READ_URL_MAX_URL_LENGTH) {
    throw new Error(
      `read_url.invalid_input: \`url\` exceeds ${READ_URL_MAX_URL_LENGTH} char limit`,
    );
  }

  if (r.max_chars != null) {
    if (
      typeof r.max_chars !== "number" ||
      !Number.isFinite(r.max_chars) ||
      r.max_chars <= 0 ||
      !Number.isInteger(r.max_chars)
    ) {
      throw new Error(
        "read_url.invalid_input: `max_chars` must be a positive integer",
      );
    }
  }

  if (r.timeout_ms != null) {
    if (
      typeof r.timeout_ms !== "number" ||
      !Number.isFinite(r.timeout_ms) ||
      r.timeout_ms <= 0
    ) {
      throw new Error(
        "read_url.invalid_input: `timeout_ms` must be a finite positive number",
      );
    }
  }

  return {
    url: r.url,
    max_chars: r.max_chars as number | undefined,
    timeout_ms: r.timeout_ms as number | undefined,
  };
}

// ─── SSRF URL validation ─────────────────────────────────────────────────

export interface ReadUrlValidationResult {
  ok: boolean;
  /** When ok=true, the normalized URL we will fetch. */
  fetchUrl?: string;
  /** When ok=false, a user-visible reason. */
  reason?: string;
}

/**
 * Validate the URL for the SSRF fence. Shares `isPrivateOrLoopbackHost`
 * with analyze_image to keep one source of truth for the blocked-host
 * list. Rejects:
 *   - non-https (including data:, file:, http:, javascript:)
 *   - empty / "/" pathless hosts (belt-and-braces, blocks bare-domain
 *     probes and matches analyze_image's allow-public behavior)
 *   - loopback, RFC1918, link-local, AWS/GCP metadata ranges
 *
 * Strips fragment (doesn't travel over the wire and can leak into logs).
 * Preserves query string.
 *
 * NOTE: DNS is NOT resolved here. A public DNS name that resolves to a
 * private IP is a residual SSRF vector (DNS rebinding). Day 5 TRUST_POLICY
 * marks read_url output as UNTRUSTED to contain downstream damage; a
 * hardened V2 path should resolve + re-check the IP before the fetch.
 */
export function validateReadUrl(rawUrl: string): ReadUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      reason: "read_url.ssrf: malformed URL (URL constructor threw)",
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `read_url.ssrf: protocol \`${parsed.protocol}\` not allowed — https only`,
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host) {
    return {
      ok: false,
      reason: "read_url.ssrf: empty host",
    };
  }
  if (isPrivateOrLoopbackHost(host)) {
    return {
      ok: false,
      reason: `read_url.ssrf: host \`${host}\` blocked (loopback / private / metadata range)`,
    };
  }

  // Drop fragment; preserve search.
  const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  return { ok: true, fetchUrl: normalized };
}

// ─── Content-type handling ───────────────────────────────────────────────

/**
 * Split a raw `Content-Type` header like `text/html; charset=utf-8` into
 * the lower-cased media type only. Returns "" if the header is empty.
 */
export function extractMediaType(header: string | null): string {
  if (!header) return "";
  return header.split(";")[0].trim().toLowerCase();
}

/**
 * True if the given media type is one we know how to compact. Matches the
 * whitelist exactly plus any `+json` / `+xml` vendor suffixes (common for
 * REST APIs that return e.g. `application/vnd.github+json`).
 */
export function isAllowedContentType(mediaType: string): boolean {
  if (!mediaType) return false;
  if (READ_URL_ALLOWED_CONTENT_TYPES.has(mediaType)) return true;
  if (mediaType.endsWith("+json")) return true;
  if (mediaType.endsWith("+xml")) return true;
  return false;
}

// ─── HTML → text compaction ──────────────────────────────────────────────

/**
 * Strip `<script>`, `<style>`, `<noscript>`, `<iframe>`, `<svg>` blocks
 * (including their contents), then strip remaining tags, decode common
 * HTML entities, and collapse whitespace.
 *
 * Intentionally simple. We do NOT pull in a full HTML parser (jsdom /
 * cheerio) — 99% of pages compact fine with regex, and a parser would
 * expand the tool's attack surface (HTML parsing bugs in untrusted input).
 *
 * Regex caveats:
 *   - /<script[^>]*>[\s\S]*?<\/script>/gi handles script-tag variants
 *     including those with attributes (`<script async src="...">`).
 *   - Non-greedy `[\s\S]*?` avoids eating the rest of the doc on broken
 *     markup.
 *   - Tag-stripper `<[^>]+>` uses `[^>]+` which doesn't handle `>` inside
 *     attribute values. Attribute-value `>` is rare in real HTML and the
 *     worst case is leftover text that looks like `attr="value` — LLMs
 *     tolerate mild noise.
 */
export function compactHtmlToText(html: string): string {
  const SCRIPT_TAG = /<script[^>]*>[\s\S]*?<\/script>/gi;
  const STYLE_TAG = /<style[^>]*>[\s\S]*?<\/style>/gi;
  const NOSCRIPT_TAG = /<noscript[^>]*>[\s\S]*?<\/noscript>/gi;
  const IFRAME_TAG = /<iframe[^>]*>[\s\S]*?<\/iframe>/gi;
  const SVG_TAG = /<svg[^>]*>[\s\S]*?<\/svg>/gi;
  const HEAD_TAG = /<head[^>]*>[\s\S]*?<\/head>/gi;
  const HTML_COMMENT = /<!--[\s\S]*?-->/g;

  let t = html;
  t = t.replace(HTML_COMMENT, "");
  t = t.replace(SCRIPT_TAG, "");
  t = t.replace(STYLE_TAG, "");
  t = t.replace(NOSCRIPT_TAG, "");
  t = t.replace(IFRAME_TAG, "");
  t = t.replace(SVG_TAG, "");
  t = t.replace(HEAD_TAG, "");

  // Turn common block-level tags into paragraph breaks BEFORE stripping
  // remaining tags, so the compacted output retains paragraph boundaries
  // rather than becoming one giant run-on line.
  t = t.replace(/<\/(p|div|section|article|li|tr|br|h[1-6])[^>]*>/gi, "\n");
  t = t.replace(/<br[^>]*>/gi, "\n");

  // Strip remaining tags.
  t = t.replace(/<[^>]+>/g, "");

  // Decode common HTML entities. Numeric entities (`&#NNN;` / `&#xHH;`)
  // handled via a tiny helper; named entities limited to the frequent ones
  // to avoid shipping a 2500-entry table.
  t = decodeHtmlEntities(t);

  // Collapse whitespace: preserve paragraph breaks (2+ newlines), squash
  // everything else.
  t = t.replace(/[ \t\f\v]+/g, " ");
  t = t.replace(/ ?\n ?/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/**
 * Decode named + numeric HTML entities. Named set covers the ~20 most
 * common; numeric form handles the rest without a big lookup table.
 */
export function decodeHtmlEntities(s: string): string {
  const NAMED: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "\u2014",
    ndash: "\u2013",
    hellip: "\u2026",
    copy: "\u00a9",
    reg: "\u00ae",
    trade: "\u2122",
    ldquo: "\u201c",
    rdquo: "\u201d",
    lsquo: "\u2018",
    rsquo: "\u2019",
    laquo: "\u00ab",
    raquo: "\u00bb",
    middot: "\u00b7",
    bull: "\u2022",
    deg: "\u00b0",
  };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const lower = body.toLowerCase();
    return NAMED[lower] ?? match;
  });
}

/**
 * Truncate `s` to at most `maxChars`. Adds ellipsis + explicit
 * `[truncated]` marker so Luca knows the content was clipped and can
 * re-fetch with a lower offset if needed (future: range support).
 */
export function truncateCompacted(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const marker = "\u2026 [truncated]";
  const sliceLen = Math.max(0, maxChars - marker.length);
  return s.slice(0, sliceLen) + marker;
}

/**
 * Apply the right compaction strategy based on media type. HTML → stripped
 * text. JSON/plain/markdown/xml → trimmed as-is.
 */
export function compactByMediaType(body: string, mediaType: string): string {
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    return compactHtmlToText(body);
  }
  // JSON/text/markdown/xml: trim, leave structure intact.
  return body.trim();
}

// ─── SF3 code sha ────────────────────────────────────────────────────────

/**
 * SF3 identity: url + max_chars. Same URL + same max_chars → same sha,
 * even if the page contents change between calls. Timeout NOT in identity.
 */
export function computeReadUrlSha(url: string, maxChars: number): string {
  const paramsStr = JSON.stringify({ max_chars: maxChars });
  return createHash("sha256").update(url + paramsStr).digest("hex");
}

// ─── Tool-run forensic insert ────────────────────────────────────────────

export interface ReadUrlContext {
  userId: number;
  agentId?: number | null;
  meetingId?: string | null;
  turnId?: string | null;
  ctxKey: SandboxKey;
}

export interface ReadUrlRunnerInput {
  url: string;
  max_chars: number;
  timeout_ms: number;
}

export async function insertPendingReadUrlRun(
  ctx: ReadUrlContext,
  input: ReadUrlRunnerInput,
  codeSha: string,
): Promise<void> {
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_read_url",
    codeSha,
    status: "pending",
    input: input as unknown as Record<string, unknown>,
    output: null,
    errorDetail: null,
    elapsedMs: null,
    memoryPeakBytes: null,
    networkAttempted: true,
  });
}

export interface ReadUrlTerminalInfo {
  status: "ok" | "error" | "timeout";
  finalUrl?: string;
  mediaType?: string;
  bytesRead?: number;
  charsReturned?: number;
  truncated?: boolean;
  redirectHops?: number;
  elapsedMs: number;
  errorDetail?: string;
}

export async function insertTerminalReadUrlRun(
  ctx: ReadUrlContext,
  input: ReadUrlRunnerInput,
  codeSha: string,
  info: ReadUrlTerminalInfo,
): Promise<void> {
  const output =
    info.status === "ok"
      ? ({
          final_url: info.finalUrl,
          media_type: info.mediaType,
          bytes_read: info.bytesRead,
          chars_returned: info.charsReturned,
          truncated: info.truncated,
          redirect_hops: info.redirectHops,
          elapsed_ms: info.elapsedMs,
        } as unknown as Record<string, unknown>)
      : null;
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_read_url",
    codeSha,
    status: info.status,
    input: input as unknown as Record<string, unknown>,
    output,
    errorDetail: info.errorDetail ?? null,
    elapsedMs: info.elapsedMs,
    memoryPeakBytes: null,
    networkAttempted: true,
  });
}

// ─── Redirect-aware fetch with SSRF re-check ─────────────────────────────

export interface ReadUrlFetchResult {
  finalUrl: string;
  mediaType: string;
  body: string;
  bytesRead: number;
  redirectHops: number;
}

/**
 * Fetch `url` with manual redirect chasing. Each hop's Location header is
 * re-validated through `validateReadUrl` BEFORE issuing the next request,
 * closing the classic `301 → http://169.254.169.254/` SSRF bypass.
 *
 * Enforces:
 *   - Content-Length pre-check (>2MB → early reject)
 *   - Actual bytes cap (body read is length-capped in case server lied)
 *   - Content-Type whitelist on TERMINAL response only (intermediate
 *     hops don't carry meaningful CT)
 *   - Max redirect hops (loop protection)
 *   - Shared timeout budget across all hops (single AbortController)
 */
export async function fetchUrlWithRedirects(
  initialUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<ReadUrlFetchResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  let currentUrl = initialUrl;
  let hops = 0;

  try {
    // Intentional: use while(true) with explicit break/return — mirrors
    // the redirect-chase pattern. Each iteration re-validates `currentUrl`
    // against the SSRF fence.
    while (true) {
      const validation = validateReadUrl(currentUrl);
      if (!validation.ok || !validation.fetchUrl) {
        throw new Error(
          `read_url.fetch: redirect target rejected — ${validation.reason ?? "unknown"}`,
        );
      }
      const hopUrl = validation.fetchUrl;

      let resp: Response;
      try {
        resp = await fetchFn(hopUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            // Generic UA — some hosts 403 no-UA requests.
            "User-Agent": "LucaReadUrl/1.0 (+https://usekioku.com)",
            Accept:
              "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1",
          },
          signal: ctl.signal,
        });
      } catch (e) {
        if (ctl.signal.aborted) {
          throw new Error(`read_url.fetch: timeout after ${timeoutMs}ms`);
        }
        throw new Error(
          `read_url.fetch: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Redirect? Chase it, re-validating.
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        if (!location) {
          throw new Error(
            `read_url.fetch: HTTP ${resp.status} with no Location header`,
          );
        }
        hops += 1;
        if (hops > READ_URL_MAX_REDIRECTS) {
          throw new Error(
            `read_url.fetch: exceeded ${READ_URL_MAX_REDIRECTS} redirect hops`,
          );
        }
        // Resolve relative redirect against current URL.
        let nextUrl: string;
        try {
          nextUrl = new URL(location, hopUrl).toString();
        } catch {
          throw new Error(
            `read_url.fetch: redirect Location \`${location}\` is not a valid URL`,
          );
        }
        currentUrl = nextUrl;
        continue;
      }

      // Non-redirect terminal response. Must be 2xx.
      if (!resp.ok) {
        throw new Error(
          `read_url.fetch: HTTP ${resp.status} ${resp.statusText}`,
        );
      }

      // Pre-check Content-Length before we read the body.
      const contentLength = resp.headers.get("content-length");
      if (contentLength != null) {
        const claimed = parseInt(contentLength, 10);
        if (Number.isFinite(claimed) && claimed > READ_URL_MAX_BYTES) {
          throw new Error(
            `read_url.fetch: Content-Length ${claimed} exceeds ${READ_URL_MAX_BYTES} byte cap`,
          );
        }
      }

      const mediaType = extractMediaType(resp.headers.get("content-type"));
      if (!isAllowedContentType(mediaType)) {
        throw new Error(
          `read_url.fetch: content-type \`${mediaType || "unknown"}\` not in whitelist (text/html, text/plain, application/json, text/markdown, xhtml, xml)`,
        );
      }

      // Read body with hard byte cap. We buffer the whole thing to enforce
      // the cap before decoding; 2MB is small enough that streaming isn't
      // worth the complexity here.
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > READ_URL_MAX_BYTES) {
        throw new Error(
          `read_url.fetch: body exceeds ${READ_URL_MAX_BYTES} byte cap (got ${buf.length})`,
        );
      }

      // Decode as UTF-8. For non-UTF-8 charsets the text will look mojibake
      // but the LLM handles that better than a hard error. We explicitly
      // don't pull in iconv-lite — legitimate modern pages are UTF-8.
      const body = buf.toString("utf8");

      return {
        finalUrl: hopUrl,
        mediaType,
        body,
        bytesRead: buf.length,
        redirectHops: hops,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main handler ────────────────────────────────────────────────────────

export interface ReadUrlToolResult {
  status: "ok" | "error" | "timeout" | "disabled";
  content: string;
  final_url?: string;
  media_type?: string;
  bytes_read?: number;
  chars_returned?: number;
  truncated?: boolean;
  redirect_hops?: number;
  error?: string;
}

export interface ReadUrlDeps {
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
}

/**
 * Invoke the tool. Returns the user-facing result shape.
 *
 * Pass-2 TOOL_TRUST_POLICY: page contents are attacker-controlled. Day 5
 * trust-policy PR will tag this tool's output as **UNTRUSTED**. Luca must
 * NOT execute instructions found inside fetched pages.
 */
export async function readUrlHandler(
  raw: unknown,
  ctx: ReadUrlContext,
  deps: ReadUrlDeps = {},
): Promise<ReadUrlToolResult> {
  // Three-level flag check first — no tool_runs row if tool shouldn't exist.
  if (!isLucaToolEnabled("LUCA_TOOL_READ_URL_ENABLED")) {
    return {
      status: "disabled",
      content: "",
      error: "luca_feature_disabled: read_url tool is not enabled",
    };
  }

  const input = parseReadUrlInput(raw);

  // SSRF fence BEFORE any network/DB work. Fail-closed on bad URL.
  const ssrf = validateReadUrl(input.url);
  if (!ssrf.ok || !ssrf.fetchUrl) {
    return {
      status: "error",
      content: "",
      error: ssrf.reason ?? "read_url.ssrf: URL rejected",
    };
  }

  const maxChars = Math.min(
    input.max_chars ?? READ_URL_DEFAULT_MAX_CHARS,
    READ_URL_CAP_MAX_CHARS,
  );
  const timeoutMs = Math.min(
    input.timeout_ms ?? READ_URL_DEFAULT_TIMEOUT_MS,
    READ_URL_MAX_TIMEOUT_MS,
  );

  const codeSha = computeReadUrlSha(ssrf.fetchUrl, maxChars);
  const runnerInput: ReadUrlRunnerInput = {
    url: ssrf.fetchUrl,
    max_chars: maxChars,
    timeout_ms: timeoutMs,
  };

  // Pending row BEFORE network call.
  try {
    await insertPendingReadUrlRun(ctx, runnerInput, codeSha);
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.readUrl] failed to insert pending tool_runs row",
    );
  }

  const startedAt = Date.now();

  let fetched: ReadUrlFetchResult;
  try {
    fetched = await fetchUrlWithRedirects(
      ssrf.fetchUrl,
      timeoutMs,
      deps.fetchFn ?? fetch,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = /timeout/i.test(msg);
    const status: "timeout" | "error" = isTimeout ? "timeout" : "error";
    logger.warn(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.readUrl] fetch failed",
    );
    try {
      await insertTerminalReadUrlRun(ctx, runnerInput, codeSha, {
        status,
        elapsedMs,
        errorDetail: msg,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.readUrl] failed to insert terminal tool_runs row after fetch fail",
      );
    }
    return { status, content: "", error: msg };
  }

  // Compact + truncate.
  const compacted = compactByMediaType(fetched.body, fetched.mediaType);
  const truncated = compacted.length > maxChars;
  const content = truncateCompacted(compacted, maxChars);

  const elapsedMs = Date.now() - startedAt;
  try {
    await insertTerminalReadUrlRun(ctx, runnerInput, codeSha, {
      status: "ok",
      finalUrl: fetched.finalUrl,
      mediaType: fetched.mediaType,
      bytesRead: fetched.bytesRead,
      charsReturned: content.length,
      truncated,
      redirectHops: fetched.redirectHops,
      elapsedMs,
    });
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.readUrl] failed to insert terminal tool_runs row on success",
    );
    // Forensic loss but result valid.
  }

  return {
    status: "ok",
    content,
    final_url: fetched.finalUrl,
    media_type: fetched.mediaType,
    bytes_read: fetched.bytesRead,
    chars_returned: content.length,
    truncated,
    redirect_hops: fetched.redirectHops,
  };
}

// ─── Convenience re-exports ──────────────────────────────────────────────

export { LucaFeatureDisabledError };

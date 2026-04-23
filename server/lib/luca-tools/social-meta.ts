/**
 * Luca Day 10 — Social media metadata fallback.
 *
 * Problem: `luca_read_url` does a plain fetch + HTML strip. On JS-heavy
 * sites (Instagram, TikTok, Twitter/X, YouTube, Vimeo, Facebook) the
 * server returns an empty JS shell with no readable content, so Luca
 * sees nothing when the user shares a public post link.
 *
 * Fix: when the URL hostname matches one of the known social-media
 * providers, shell out to `yt-dlp --dump-single-json --skip-download`
 * BEFORE the plain fetch. yt-dlp uses each site's public/mobile/oembed
 * API to get caption, uploader, duration, upload date, view/like counts
 * without any login. If that succeeds, we compose a plain-text summary
 * and return it as if it had been fetched normally.
 *
 * Safety:
 *   - Only runs for allow-listed social hosts; other URLs go through
 *     the existing plain-fetch path untouched.
 *   - yt-dlp is invoked with `--skip-download` (no bytes written) and
 *     `--no-playlist` (no recursion) and a 20s hard timeout.
 *   - Output is parsed as JSON; all string fields are truncated before
 *     joining.
 *   - Errors (timeout, network, unsupported URL, age-gated, private)
 *     return `null` so the caller falls back to plain fetch.
 *   - Content is still flagged UNTRUSTED by the trust policy on the
 *     calling side (no change to trust-policy.ts).
 *
 * SSRF: the URL is already validated by `validateReadUrl()` before this
 * runs, so the host is known public at the time of call. yt-dlp may do
 * redirects internally, but they stay within the provider's API domain
 * — we don't feed yt-dlp output URLs back to `fetch()`.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import logger from "../../logger";

const execFileAsync = promisify(execFile);

/** How long yt-dlp is allowed to run before we kill it (per attempt). */
export const SOCIAL_META_TIMEOUT_MS = 20_000;

/** Max chars for any individual string field after yt-dlp parse. */
const MAX_FIELD_CHARS = 4_000;

/**
 * User-Agents used across retries. Instagram in particular will rate-limit
 * the same UA on consecutive calls; rotating buys us a second chance.
 */
const RETRY_USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
];

/**
 * Outcome of a social-meta lookup. `null`-returning API is kept for
 * backwards compatibility, but `readSocialMetaDetailed` exposes the reason
 * so callers can surface a login-wall message to Luca instead of silently
 * falling through to the doomed plain-fetch path.
 */
export type SocialMetaFailureReason =
  | "login_wall"     // yt-dlp explicitly reported auth required / rate-limit
  | "unsupported"    // platform extractor said URL is not a supported post
  | "private"        // post visible only to followers
  | "not_found"      // 404 / post deleted
  | "timeout"        // hit SOCIAL_META_TIMEOUT_MS on every attempt
  | "empty"          // yt-dlp returned null JSON without an explicit error
  | "generic";       // anything else

export interface SocialMetaResult {
  ok: boolean;
  text?: string;
  reason?: SocialMetaFailureReason;
  errorMessage?: string;
}

/**
 * Hosts where plain fetch returns a JS shell. Suffix match — bare host
 * AND subdomains count (e.g. `www.instagram.com`, `m.instagram.com`).
 *
 * Ordering doesn't matter; membership is checked by endsWith.
 */
export const SOCIAL_HOSTS: readonly string[] = [
  "instagram.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "facebook.com",
  "fb.watch",
  "reddit.com",
];

/**
 * Return true if this host is served by yt-dlp's social extractors.
 * Host must be lowercased — SSRF validator already lowercases it.
 */
export function isSocialHost(host: string): boolean {
  const h = host.toLowerCase();
  return SOCIAL_HOSTS.some(
    (social) => h === social || h.endsWith(`.${social}`),
  );
}

/**
 * Raw JSON shape from `yt-dlp --dump-single-json`. We only touch the
 * fields we care about; everything else is ignored.
 */
export interface YtdlpJson {
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  duration?: number;
  upload_date?: string; // YYYYMMDD
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  webpage_url?: string;
  extractor_key?: string;
  _type?: string;
}

function clip(s: string, max = MAX_FIELD_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n… [truncated]";
}

function formatDuration(sec: number | undefined): string | null {
  if (sec == null || !isFinite(sec) || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function formatDate(yyyymmdd: string | undefined): string | null {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Compose a plain-text summary of a yt-dlp JSON record. Designed so it
 * reads naturally when the LLM treats it as document text.
 *
 * Format is stable (name: value lines + blank line + description), so
 * downstream prompt templates can rely on it.
 */
export function formatSocialMeta(meta: YtdlpJson): string {
  const lines: string[] = [];
  const siteName = meta.extractor_key || "Social post";
  lines.push(`[Social post read via ${siteName}]`);

  if (meta.title) lines.push(`Title: ${clip(meta.title, 500)}`);
  const author = meta.uploader || meta.channel || meta.uploader_id;
  if (author) lines.push(`Author: ${author}`);
  const date = formatDate(meta.upload_date);
  if (date) lines.push(`Posted: ${date}`);
  const dur = formatDuration(meta.duration);
  if (dur) lines.push(`Duration: ${dur}`);
  const stats: string[] = [];
  if (typeof meta.view_count === "number") stats.push(`${meta.view_count} views`);
  if (typeof meta.like_count === "number") stats.push(`${meta.like_count} likes`);
  if (typeof meta.comment_count === "number") stats.push(`${meta.comment_count} comments`);
  if (stats.length) lines.push(`Stats: ${stats.join(" · ")}`);
  if (meta.webpage_url) lines.push(`URL: ${meta.webpage_url}`);

  if (meta.description && meta.description.trim()) {
    lines.push("");
    lines.push("Description / caption:");
    lines.push(clip(meta.description.trim()));
  }

  return lines.join("\n");
}

/**
 * Parse a yt-dlp stderr line into a known failure reason. yt-dlp error
 * strings are stable enough that regex matching is fine; we err on the
 * side of `generic` for anything we can't classify.
 */
export function classifyYtdlpStderr(stderr: string | undefined): SocialMetaFailureReason {
  if (!stderr) return "empty";
  const s = stderr.toLowerCase();
  if (/rate-?limit/.test(s)) return "login_wall";
  if (/login.*required|requires?.*login|authentication|authorization/.test(s))
    return "login_wall";
  if (/--cookies/.test(s)) return "login_wall"; // yt-dlp's hint that cookies would unblock
  if (/unsupported url|is not a valid url|no video.*found/.test(s)) return "unsupported";
  if (/private/.test(s)) return "private";
  if (/unavailable|removed|deleted|not ?found|404/.test(s)) return "not_found";
  if (/timed? ?out|timeout/.test(s)) return "timeout";
  return "generic";
}

/**
 * Short, human-readable summary of a failure reason — used to build the
 * text we show Luca when yt-dlp cannot read a social post.
 */
export function describeSocialFailure(
  reason: SocialMetaFailureReason,
  extractor?: string,
): string {
  const site = extractor || "the platform";
  switch (reason) {
    case "login_wall":
      return `${site} blocked automated reading of this post (rate-limit or login required). The link may load fine in a logged-in browser, but Luca cannot reach it right now.`;
    case "private":
      return `This post appears to be private — only the author's followers can see it.`;
    case "not_found":
      return `${site} reports this post as unavailable (deleted, removed, or never existed).`;
    case "unsupported":
      return `${site} returned the URL but no post/video content could be extracted.`;
    case "timeout":
      return `Timed out while reading ${site}.`;
    case "empty":
      return `${site} responded but returned no readable fields.`;
    default:
      return `${site} could not be read.`;
  }
}

/** Host → pretty platform name for fallback messages. */
function hostToPlatform(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (h.endsWith("instagram.com")) return "Instagram";
    if (h.endsWith("tiktok.com")) return "TikTok";
    if (h.endsWith("twitter.com") || h.endsWith("x.com")) return "Twitter/X";
    if (h.endsWith("youtube.com") || h.endsWith("youtu.be")) return "YouTube";
    if (h.endsWith("vimeo.com")) return "Vimeo";
    if (h.endsWith("facebook.com") || h.endsWith("fb.watch")) return "Facebook";
    if (h.endsWith("reddit.com")) return "Reddit";
    return h;
  } catch {
    return "the platform";
  }
}

async function runYtdlpOnce(
  execFn: typeof execFileAsync,
  bin: string,
  url: string,
  ua: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFn(
    bin,
    [
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout",
      "15",
      "--user-agent",
      ua,
      url,
    ],
    {
      timeout: SOCIAL_META_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf-8",
    },
  );
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

/**
 * Detailed variant used internally by read-url.ts. Returns both success
 * text and a classified failure reason so callers can decide whether to
 * surface a login-wall message to the LLM (rather than silently falling
 * through to a plain fetch that will also return nothing).
 *
 * Never throws — always resolves.
 *
 * Retry policy: up to 2 attempts with different User-Agents. We do NOT
 * retry on `unsupported` / `private` / `not_found` — those are permanent.
 */
export async function readSocialMetaDetailed(
  url: string,
  deps: {
    execFileFn?: typeof execFileAsync;
    ytDlpBin?: string;
    userAgents?: readonly string[];
  } = {},
): Promise<SocialMetaResult> {
  const execFn = deps.execFileFn ?? execFileAsync;
  const bin = deps.ytDlpBin ?? "yt-dlp";
  const agents = deps.userAgents ?? RETRY_USER_AGENTS;

  let lastReason: SocialMetaFailureReason = "empty";
  let lastStderr = "";

  for (let i = 0; i < agents.length; i++) {
    const ua = agents[i];
    try {
      const { stdout, stderr } = await runYtdlpOnce(execFn, bin, url, ua);
      // stderr non-empty while stdout looks valid still counts as success —
      // yt-dlp emits warnings to stderr even on clean runs.
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === "null") {
        // `null` is yt-dlp's way of saying "extractor ran, post unavailable".
        lastReason = classifyYtdlpStderr(stderr);
        lastStderr = stderr;
        if (lastReason === "unsupported" || lastReason === "private" || lastReason === "not_found") {
          break; // permanent, don't retry
        }
        continue; // retry with next UA
      }
      let parsed: YtdlpJson;
      try {
        parsed = JSON.parse(trimmed) as YtdlpJson;
      } catch (e) {
        logger.warn({ url, err: (e as Error).message }, "[luca.social-meta] JSON parse failed");
        lastReason = "generic";
        continue;
      }
      // JSON.parse("null") → null. Guard explicitly.
      if (parsed === null || typeof parsed !== "object") {
        lastReason = classifyYtdlpStderr(stderr);
        lastStderr = stderr;
        if (lastReason === "unsupported" || lastReason === "private" || lastReason === "not_found") {
          break;
        }
        continue;
      }
      if (parsed._type && parsed._type !== "video") {
        logger.debug({ url, type: parsed._type }, "[luca.social-meta] non-video type");
        lastReason = "unsupported";
        break;
      }
      const hasAny =
        parsed.title ||
        parsed.description ||
        parsed.uploader ||
        parsed.channel ||
        parsed.uploader_id;
      if (!hasAny) {
        lastReason = "empty";
        continue;
      }
      return { ok: true, text: formatSocialMeta(parsed) };
    } catch (e: any) {
      const stderr = typeof e?.stderr === "string" ? e.stderr : "";
      lastStderr = stderr;
      // execFile throws with `killed: true, signal: 'SIGTERM'` on timeout.
      if (e?.killed || e?.signal === "SIGTERM" || /timeout/i.test(e?.message ?? "")) {
        lastReason = "timeout";
      } else {
        lastReason = classifyYtdlpStderr(stderr) || "generic";
      }
      logger.warn(
        { url, err: e?.message ?? String(e), code: e?.code, signal: e?.signal, reason: lastReason, attempt: i + 1 },
        "[luca.social-meta] yt-dlp attempt failed",
      );
      if (lastReason === "unsupported" || lastReason === "private" || lastReason === "not_found") {
        break;
      }
    }
  }

  return { ok: false, reason: lastReason, errorMessage: lastStderr.slice(0, 500) };
}

/**
 * Build the user-visible string to return when social-meta extraction
 * failed. This is surfaced to Luca AS the read_url content so he can see
 * the link was a social post but rate-limited / private — much better
 * than empty text or a generic "read failed" error.
 */
export function formatSocialFailure(url: string, reason: SocialMetaFailureReason): string {
  const platform = hostToPlatform(url);
  return [
    `[Social post read via ${platform} — FAILED]`,
    `URL: ${url}`,
    ``,
    describeSocialFailure(reason, platform),
    ``,
    `If you need to know what the post says, ask the user to paste the caption or a screenshot.`,
  ].join("\n");
}

/**
 * Legacy wrapper that returns only the success string (or null). New
 * callers should use readSocialMetaDetailed so they can distinguish a
 * login-wall from a genuinely non-social URL.
 */
export async function readSocialMeta(
  url: string,
  deps: {
    execFileFn?: typeof execFileAsync;
    ytDlpBin?: string;
  } = {},
): Promise<string | null> {
  const res = await readSocialMetaDetailed(url, deps);
  return res.ok && res.text ? res.text : null;
}

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

/** How long yt-dlp is allowed to run before we kill it. */
export const SOCIAL_META_TIMEOUT_MS = 20_000;

/** Max chars for any individual string field after yt-dlp parse. */
const MAX_FIELD_CHARS = 4_000;

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
 * Run yt-dlp against the URL and return a plain-text summary. Returns
 * null on any failure (caller falls back to the plain-fetch path).
 *
 * Never throws — always resolves.
 */
export async function readSocialMeta(
  url: string,
  deps: {
    execFileFn?: typeof execFileAsync;
    ytDlpBin?: string;
  } = {},
): Promise<string | null> {
  const execFn = deps.execFileFn ?? execFileAsync;
  const bin = deps.ytDlpBin ?? "yt-dlp";

  try {
    const { stdout } = await execFn(
      bin,
      [
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout",
        "15",
        url,
      ],
      {
        timeout: SOCIAL_META_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024, // 10MB — descriptions can be long
        encoding: "utf-8",
      },
    );
    if (!stdout || !stdout.trim()) {
      logger.debug({ url }, "[luca.social-meta] empty stdout");
      return null;
    }
    let parsed: YtdlpJson;
    try {
      parsed = JSON.parse(stdout) as YtdlpJson;
    } catch (e) {
      logger.warn({ url, err: (e as Error).message }, "[luca.social-meta] JSON parse failed");
      return null;
    }
    // Reject playlists — we only want single-post metadata.
    if (parsed._type && parsed._type !== "video") {
      logger.debug(
        { url, type: parsed._type },
        "[luca.social-meta] skipping non-video type",
      );
      return null;
    }
    const hasAny =
      parsed.title ||
      parsed.description ||
      parsed.uploader ||
      parsed.channel ||
      parsed.uploader_id;
    if (!hasAny) {
      logger.debug({ url }, "[luca.social-meta] no usable fields");
      return null;
    }
    return formatSocialMeta(parsed);
  } catch (e: any) {
    logger.warn(
      { url, err: e?.message ?? String(e), code: e?.code, signal: e?.signal },
      "[luca.social-meta] yt-dlp failed",
    );
    return null;
  }
}

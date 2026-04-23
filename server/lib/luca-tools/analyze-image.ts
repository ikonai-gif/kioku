/**
 * Luca V1a Day 3 — `analyze_image` tool.
 *
 * Anthropic vision — caller passes an image URL, we fetch it (SF4-whitelisted
 * regional S3 or data: URI — see `parseAnalyzeImageInput`), base64-encode it
 * into an Anthropic image content block, ship to claude-sonnet-4-6, return
 * the textual description. Logs forensic `tool_runs` row pair like run_code.
 *
 * Three-level flag defense (same as run_code):
 *   1. `LUCA_V1A_ENABLED=true` (master)
 *   2. `LUCA_TOOLS_ENABLED=true` (tool-registry master)
 *   3. `LUCA_TOOL_ANALYZE_IMAGE_ENABLED=true` (per-tool)
 *
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
 *
 * SF3 — `code_sha = sha256(url + JSON.stringify({prompt, max_tokens}))`.
 *   Per-call dedup via same URL + same prompt params. If Luca re-asks the
 *   exact same question on the exact same image, SF3 groups them in
 *   tool_runs even though outputs may differ (Anthropic non-determinism).
 *   We chose `url` (not fetched bytes) as the identity key for SF3: URL is
 *   the stable handle; re-fetching the same URL twice should yield the same
 *   logical object for immutable S3 content. If the content at that URL
 *   changes (mutable S3 key), SF3 will over-group — acceptable for V1a, as
 *   Luca's own storage convention is content-addressed (generate_image
 *   writes uniquely-keyed objects).
 *
 * Network: YES (both to S3 and to Anthropic). `network_attempted=true` in
 * tool_runs row. Unlike run_code (Pyodide sandboxed, zero egress), this
 * tool reaches out twice per call.
 *
 * Forensic log rows (same pattern as run_code):
 *   - "pending" row before the Anthropic call — captures input + ctxKey
 *     even if fetch or API call throws.
 *   - Terminal row ("ok"|"error"|"timeout"|"disabled") after completion.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { db } from "../../storage";
import { toolRuns } from "../../../shared/schema";
import {
  isLucaToolEnabled,
  readLucaEnv,
  LucaFeatureDisabledError,
} from "../luca/env";
import { withAnthropicBreaker } from "../anthropic-client";
import type { SandboxKey } from "../luca/pyodide-runner";
import logger from "../../logger";

// ─── Policy constants ────────────────────────────────────────────────────

/** Default per-call timeout when caller doesn't specify. */
export const ANALYZE_IMAGE_DEFAULT_TIMEOUT_MS = 30_000;

/** Tool-layer ceiling. Caller cannot raise above this. */
export const ANALYZE_IMAGE_MAX_TIMEOUT_MS = 60_000;

/** Default max_tokens for the Anthropic response. */
export const ANALYZE_IMAGE_DEFAULT_MAX_TOKENS = 1024;

/** Ceiling for max_tokens (caller can lower). */
export const ANALYZE_IMAGE_MAX_MAX_TOKENS = 4096;

/**
 * Max image size we will fetch + base64 into an Anthropic message.
 * Anthropic docs state vision supports up to ~5MB per image; we cap fetch
 * at 10MB to give a clear "image too large" error rather than a confusing
 * Anthropic 400. Base64 encoding inflates ~33% so 10MB raw ≈ 13.3MB body.
 */
export const ANALYZE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Anthropic vision model. Defaults to claude-sonnet-4-6 to match the rest
 * of the codebase (deliberation default, meeting-turn-runner tests). The
 * old claude-3-5-sonnet-20241022 alias returns not_found_error on current
 * API keys — confirmed during Day 3 smoke. Override via env if needed.
 */
const VISION_MODEL =
  process.env.LUCA_ANALYZE_IMAGE_MODEL || "claude-sonnet-4-6";

/** Default prompt when caller omits. */
export const DEFAULT_PROMPT = "Describe this image in detail.";

/**
 * MIME types Anthropic vision accepts. Enforced client-side so we emit a
 * clean error before the API call rather than letting Anthropic 400 us.
 */
const ANTHROPIC_VISION_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// ─── Anthropic tool definition ───────────────────────────────────────────

/**
 * Anthropic Tool spec for Luca's analyze_image. Distinct from any
 * partner-chat image tool. Naming `luca_analyze_image` mirrors the
 * `luca_run_code` convention — explicit prefix prevents collision if two
 * tool lists ever converge.
 *
 * NOT a generator — this is image understanding (read-only). Luca's
 * existing `generate_image` (DALL-E 3) is the creator; analyze_image is
 * the reader.
 */
export const analyzeImageTool: Anthropic.Messages.Tool = {
  name: "luca_analyze_image",
  description:
    "Analyze an image with Anthropic vision. Pass a URL pointing to an " +
    "image in Luca's own S3 storage (generate_image output, uploaded files) " +
    "OR a data: URI. Returns a text description. Accepts jpeg/png/gif/webp, " +
    "max 10MB raw. Default prompt 'Describe this image in detail'; override " +
    "via `prompt` param for targeted questions (e.g. 'What color is the " +
    "shirt?'). Default max_tokens 1024, cap 4096. Default timeout 30s, cap 60s.",
  input_schema: {
    type: "object" as const,
    properties: {
      image_url: {
        type: "string",
        description:
          "S3 URL in Luca's configured bucket+region (any of s3://, " +
          "virtual-hosted https, or path-style https) OR a data: URI. " +
          "Arbitrary external URLs are REJECTED by SF4 sanity fence.",
      },
      prompt: {
        type: "string",
        description: `Question or instruction for the vision model. Default: "${DEFAULT_PROMPT}".`,
      },
      max_tokens: {
        type: "number",
        description: `Max response tokens. Default ${ANALYZE_IMAGE_DEFAULT_MAX_TOKENS}, cap ${ANALYZE_IMAGE_MAX_MAX_TOKENS}.`,
      },
      timeout_ms: {
        type: "number",
        description: `Override default timeout. Default ${ANALYZE_IMAGE_DEFAULT_TIMEOUT_MS}ms, cap ${ANALYZE_IMAGE_MAX_TIMEOUT_MS}ms.`,
      },
    },
    required: ["image_url"],
  },
};

// ─── Input validation ────────────────────────────────────────────────────

export interface AnalyzeImageToolInput {
  image_url: string;
  prompt?: string;
  max_tokens?: number;
  timeout_ms?: number;
}

/**
 * Parse + validate LLM-provided tool input. Throws user-visible errors.
 * Same D30 lesson as run_code: uses `Number.isFinite` guard so NaN/Infinity
 * cannot slip through a naive `<= 0` check and coerce setTimeout to 1ms.
 */
export function parseAnalyzeImageInput(raw: unknown): AnalyzeImageToolInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("analyze_image.invalid_input: expected object");
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.image_url !== "string" || r.image_url.length === 0) {
    throw new Error(
      "analyze_image.invalid_input: `image_url` must be non-empty string",
    );
  }
  if (r.image_url.length > 8192) {
    // Defensive — legitimate S3 URLs are well under 2KB. Rejects pathological
    // inputs that might otherwise bloat logs / regex backtrack in URL parser.
    throw new Error(
      "analyze_image.invalid_input: `image_url` exceeds 8KB length limit",
    );
  }

  if (r.prompt != null) {
    if (typeof r.prompt !== "string") {
      throw new Error(
        "analyze_image.invalid_input: `prompt` must be string if provided",
      );
    }
    if (r.prompt.length > 10_000) {
      throw new Error(
        "analyze_image.invalid_input: `prompt` exceeds 10KB length limit",
      );
    }
  }

  if (r.max_tokens != null) {
    if (
      typeof r.max_tokens !== "number" ||
      !Number.isFinite(r.max_tokens) ||
      r.max_tokens <= 0 ||
      !Number.isInteger(r.max_tokens)
    ) {
      throw new Error(
        "analyze_image.invalid_input: `max_tokens` must be a positive integer",
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
        "analyze_image.invalid_input: `timeout_ms` must be a finite positive number",
      );
    }
  }

  return {
    image_url: r.image_url,
    prompt: r.prompt as string | undefined,
    max_tokens: r.max_tokens as number | undefined,
    timeout_ms: r.timeout_ms as number | undefined,
  };
}

// ─── SF4 regional S3 whitelist ───────────────────────────────────────────

export interface SF4ValidationResult {
  ok: boolean;
  /** When ok=true, the URL normalized to a form we can fetch. */
  fetchUrl?: string;
  /** When ok=false, a user-visible reason. */
  reason?: string;
  /** True if url was a data: URI (no fetch needed; fetchUrl IS the data). */
  isDataUri?: boolean;
}

/**
 * Validate `image_url` against SF4 regional S3 whitelist.
 *
 * Accepts:
 *   1. `data:image/<jpeg|png|gif|webp>;base64,<...>` — inline image (no fetch)
 *   2. `s3://{LUCA_S3_BUCKET}/{key}` — canonical, rewritten to virtual-hosted
 *       https in `{LUCA_S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com`
 *   3. `https://{LUCA_S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}` — virtual-hosted regional
 *   4. `https://{LUCA_S3_BUCKET}.s3.amazonaws.com/{key}` — virtual-hosted global (us-east-1)
 *   5. `https://s3.{AWS_REGION}.amazonaws.com/{LUCA_S3_BUCKET}/{key}` — path-style regional
 *   6. `https://s3.amazonaws.com/{LUCA_S3_BUCKET}/{key}` — path-style global (us-east-1)
 *
 * Rejects:
 *   - Any other host
 *   - http:// (non-TLS) except data: URIs
 *   - Wrong bucket
 *   - Missing bucket/region env vars (fail-closed)
 *   - Malformed URL
 *
 * Query string is preserved (presigned URLs use `?X-Amz-Signature=...`).
 * Fragment is stripped (S3 doesn't use them and they can leak through logs).
 */
export function validateImageUrlSF4(imageUrl: string): SF4ValidationResult {
  // Fast-path: data: URIs never touch the network, so they bypass SF4
  // regional rules. We still enforce media type via separate check below.
  if (imageUrl.startsWith("data:")) {
    const match = /^data:([a-z0-9+/\-.]+);base64,([A-Za-z0-9+/=]+)$/i.exec(
      imageUrl,
    );
    if (!match) {
      return {
        ok: false,
        reason: "analyze_image.sf4: malformed data: URI (expect base64 form)",
      };
    }
    const mediaType = match[1].toLowerCase();
    if (!ANTHROPIC_VISION_MEDIA_TYPES.has(mediaType)) {
      return {
        ok: false,
        reason: `analyze_image.sf4: data: URI media type \`${mediaType}\` not in Anthropic vision whitelist (jpeg/png/gif/webp)`,
      };
    }
    return { ok: true, fetchUrl: imageUrl, isDataUri: true };
  }

  const env = readLucaEnv();
  const bucket = env.LUCA_S3_BUCKET;
  const region = env.AWS_REGION;
  const allowPublic = env.LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC;

  // Dev/staging escape hatch: when LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC=true,
  // bypass the S3-only check and accept arbitrary https:// hosts. SSRF
  // protection stays — localhost / private IP ranges remain rejected.
  // This is NOT a replacement for SF4 in prod; it's a smoke-test tool
  // for environments without a configured S3 bucket.
  //
  // NOTE: still runs AFTER the data: URI fast-path above and AFTER bucket
  // checks below fall through — meaning s3:// URLs still require the
  // bucket/region vars. The flag only widens the https:// path.
  if (!bucket || !region) {
    if (allowPublic) {
      if (imageUrl.startsWith("s3://")) {
        return {
          ok: false,
          reason:
            "analyze_image.sf4: s3:// scheme requires LUCA_S3_BUCKET+AWS_REGION (even in allow-public mode)",
        };
      }
      return validatePublicHttpsUrl(imageUrl);
    }
    if (!bucket) {
      return {
        ok: false,
        reason:
          "analyze_image.sf4: LUCA_S3_BUCKET not configured (fail-closed)",
      };
    }
    return {
      ok: false,
      reason: "analyze_image.sf4: AWS_REGION not configured (fail-closed)",
    };
  }

  // s3:// scheme — canonicalize to virtual-hosted https regional.
  if (imageUrl.startsWith("s3://")) {
    const rest = imageUrl.slice("s3://".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1 || slashIdx === 0) {
      return {
        ok: false,
        reason: "analyze_image.sf4: malformed s3:// URL (expect s3://bucket/key)",
      };
    }
    const s3Bucket = rest.slice(0, slashIdx);
    const key = rest.slice(slashIdx + 1);
    if (s3Bucket !== bucket) {
      return {
        ok: false,
        reason: `analyze_image.sf4: s3:// bucket \`${s3Bucket}\` not allowed (expected \`${bucket}\`)`,
      };
    }
    if (key.length === 0) {
      return {
        ok: false,
        reason: "analyze_image.sf4: s3:// URL missing object key",
      };
    }
    return {
      ok: true,
      fetchUrl: `https://${bucket}.s3.${region}.amazonaws.com/${key}`,
    };
  }

  // https:// shapes. Use URL parser — it normalizes and rejects malformed
  // inputs (missing scheme, bad host, etc) with a single throw.
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return {
      ok: false,
      reason: "analyze_image.sf4: malformed URL (URL constructor threw)",
    };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `analyze_image.sf4: protocol \`${parsed.protocol}\` not allowed — https only`,
    };
  }

  const host = parsed.hostname.toLowerCase();

  // Virtual-hosted: {bucket}.s3.{region}.amazonaws.com
  // Virtual-hosted global: {bucket}.s3.amazonaws.com (us-east-1 only)
  // Path-style regional: s3.{region}.amazonaws.com/{bucket}/...
  // Path-style global: s3.amazonaws.com/{bucket}/...
  const expectedVhostRegional = `${bucket}.s3.${region}.amazonaws.com`;
  const expectedVhostGlobal = `${bucket}.s3.amazonaws.com`;
  const expectedPathRegional = `s3.${region}.amazonaws.com`;
  const expectedPathGlobal = `s3.amazonaws.com`;

  if (host === expectedVhostRegional || host === expectedVhostGlobal) {
    // Virtual-hosted: path is just the key.
    if (parsed.pathname === "/" || parsed.pathname.length === 0) {
      return {
        ok: false,
        reason: "analyze_image.sf4: virtual-hosted URL missing object key",
      };
    }
    // Global endpoint only valid for us-east-1 buckets; we refuse to guess
    // — if caller's region is us-east-1 OR they use regional vhost, fine;
    // otherwise global-endpoint URL for a non-us-east-1 bucket would silently
    // 301 on Anthropic's fetch side. We accept both, let AWS do the final
    // routing. Preserve query string (presigned sig).
    return {
      ok: true,
      fetchUrl: `https://${host}${parsed.pathname}${parsed.search}`,
    };
  }

  if (host === expectedPathRegional || host === expectedPathGlobal) {
    // Path-style: /{bucket}/{key}
    const pathParts = parsed.pathname.split("/").filter((p) => p.length > 0);
    if (pathParts.length < 2) {
      return {
        ok: false,
        reason: "analyze_image.sf4: path-style URL missing bucket or key",
      };
    }
    if (pathParts[0] !== bucket) {
      return {
        ok: false,
        reason: `analyze_image.sf4: path-style bucket \`${pathParts[0]}\` not allowed (expected \`${bucket}\`)`,
      };
    }
    return {
      ok: true,
      fetchUrl: `https://${host}${parsed.pathname}${parsed.search}`,
    };
  }

  // If S3 path didn't match but allow-public flag is on, widen to public https.
  if (allowPublic) {
    return validatePublicHttpsUrl(imageUrl);
  }

  return {
    ok: false,
    reason: `analyze_image.sf4: host \`${host}\` not in regional S3 whitelist`,
  };
}

/**
 * Validate a generic https:// URL for the LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC
 * escape hatch. Enforces:
 *   - https:// only (no http, ftp, file, etc.)
 *   - No localhost / loopback / metadata endpoint hosts (SSRF defense)
 *   - No IPv4/IPv6 literals pointing at private ranges
 *
 * NOTE: this is DNS-blind — the hostname is checked but DNS resolution
 * still happens at fetch time, and a public DNS name could resolve to a
 * private IP (classic SSRF via DNS rebinding). For V1a smoke testing
 * this is acceptable; a hardened prod path must resolve + re-check the
 * IP before the actual fetch. Tracked in Day 5 TOOL_TRUST_POLICY notes.
 */
export function validatePublicHttpsUrl(imageUrl: string): SF4ValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return {
      ok: false,
      reason: "analyze_image.sf4: malformed URL (URL constructor threw)",
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `analyze_image.sf4: protocol \`${parsed.protocol}\` not allowed — https only (allow-public mode)`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLoopbackHost(host)) {
    return {
      ok: false,
      reason: `analyze_image.sf4: host \`${host}\` blocked (loopback / private / metadata range) in allow-public mode`,
    };
  }
  if (parsed.pathname === "/" || parsed.pathname.length === 0) {
    return {
      ok: false,
      reason: "analyze_image.sf4: URL missing path (allow-public mode)",
    };
  }
  return {
    ok: true,
    fetchUrl: `https://${host}${parsed.pathname}${parsed.search}`,
  };
}

/**
 * True if `host` is a name or IP literal that points at loopback, link-local,
 * RFC1918 private space, cloud metadata service, or similar SSRF targets.
 * Covers literal IPv4 (1.2.3.4), IPv6 ([::1]), and common names (localhost,
 * *.internal). Does NOT resolve DNS — see caller caveat.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  if (!host) return true;
  // Node's URL parser keeps IPv6 literals in [brackets]; strip them so the
  // IPv6 tests below see the bare address.
  const stripped =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const h = stripped.toLowerCase();

  // Names / suffixes.
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".internal")) return true;
  // AWS / GCP metadata service by name (belt-and-braces; IP check covers too).
  if (h === "metadata.google.internal") return true;

  // IPv6 literal (URL.hostname strips the brackets).
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    // fe80::/10 link-local, fc00::/7 unique-local
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb"))
      return true;
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    // IPv4-mapped (::ffff:a.b.c.d) — inspect the embedded v4.
    const mapped = /^::ffff:([0-9.]+)$/.exec(h);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return false;
  }

  // IPv4 literal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return isPrivateIPv4(h);
  }

  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255))
    return true; // malformed → treat as private (fail-closed)
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local + 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast + reserved
  return false;
}

// ─── Image fetch ─────────────────────────────────────────────────────────

export interface FetchedImage {
  /** Raw bytes. */
  bytes: Uint8Array;
  /** MIME type. */
  mediaType: string;
  /** Base64-encoded bytes (for Anthropic payload). */
  base64: string;
}

/**
 * Fetch an image URL and produce an Anthropic-ready base64 payload.
 * Enforces size cap + media-type whitelist. Uses an AbortController bound
 * to the caller's timeout.
 *
 * Data: URIs are "fetched" in-memory by decoding the base64 directly.
 */
export async function fetchImageForAnthropic(
  fetchUrl: string,
  timeoutMs: number,
  isDataUri: boolean,
): Promise<FetchedImage> {
  if (isDataUri) {
    // Parsed shape already validated by validateImageUrlSF4.
    const match = /^data:([a-z0-9+/\-.]+);base64,([A-Za-z0-9+/=]+)$/i.exec(
      fetchUrl,
    )!;
    const mediaType = match[1].toLowerCase();
    const base64 = match[2];
    const bytes = Buffer.from(base64, "base64");
    if (bytes.length > ANALYZE_IMAGE_MAX_BYTES) {
      throw new Error(
        `analyze_image.fetch: data: URI exceeds ${ANALYZE_IMAGE_MAX_BYTES} byte cap (got ${bytes.length})`,
      );
    }
    return { bytes: new Uint8Array(bytes), mediaType, base64 };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(fetchUrl, { signal: ctl.signal });
  } catch (e) {
    if (ctl.signal.aborted) {
      throw new Error(`analyze_image.fetch: timeout after ${timeoutMs}ms`);
    }
    throw new Error(
      `analyze_image.fetch: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(
      `analyze_image.fetch: HTTP ${resp.status} ${resp.statusText}`,
    );
  }

  // Content-Length pre-check to avoid downloading 100GB before we realize.
  const contentLength = resp.headers.get("content-length");
  if (contentLength != null) {
    const claimed = parseInt(contentLength, 10);
    if (Number.isFinite(claimed) && claimed > ANALYZE_IMAGE_MAX_BYTES) {
      throw new Error(
        `analyze_image.fetch: Content-Length ${claimed} exceeds ${ANALYZE_IMAGE_MAX_BYTES} byte cap`,
      );
    }
  }

  // Media type from response header. Fall back to magic-byte sniffing if
  // content-type is missing or generic (application/octet-stream).
  const ctHeader = (resp.headers.get("content-type") || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  let mediaType = ctHeader;
  if (!ANTHROPIC_VISION_MEDIA_TYPES.has(mediaType)) {
    // Could be a presigned S3 URL that doesn't set content-type. Buffer the
    // body (bounded by cap) and sniff magic bytes.
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > ANALYZE_IMAGE_MAX_BYTES) {
      throw new Error(
        `analyze_image.fetch: body exceeds ${ANALYZE_IMAGE_MAX_BYTES} byte cap (got ${buf.length})`,
      );
    }
    mediaType = sniffImageMagic(buf) || mediaType;
    if (!ANTHROPIC_VISION_MEDIA_TYPES.has(mediaType)) {
      throw new Error(
        `analyze_image.fetch: media type \`${mediaType || "unknown"}\` not in Anthropic vision whitelist (jpeg/png/gif/webp)`,
      );
    }
    return {
      bytes: new Uint8Array(buf),
      mediaType,
      base64: buf.toString("base64"),
    };
  }

  // Happy path: content-type is valid, stream body into bounded buffer.
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > ANALYZE_IMAGE_MAX_BYTES) {
    throw new Error(
      `analyze_image.fetch: body exceeds ${ANALYZE_IMAGE_MAX_BYTES} byte cap (got ${buf.length})`,
    );
  }
  return {
    bytes: new Uint8Array(buf),
    mediaType,
    base64: buf.toString("base64"),
  };
}

/**
 * Sniff the first few bytes of an image buffer and return the MIME type or
 * null. Covers jpeg/png/gif/webp — the Anthropic vision set.
 */
export function sniffImageMagic(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return "image/gif";
  }
  // WEBP: "RIFF" <len> "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// ─── Code sha (SF3) ──────────────────────────────────────────────────────

/**
 * SF3 identity: url + normalized params. Two calls with same URL and same
 * (prompt, max_tokens) group under one code_sha. Timeout is NOT part of
 * identity — it only affects when to give up, not what was asked.
 *
 * Pass-2 finding K: SHA does NOT hash the image bytes — only the URL. If the
 * S3 object at `imageUrl` is overwritten (same key, different content) or if
 * a versioned bucket resolves a different object version at fetch time, two
 * analyses with different bytes collide under one codeSha. Today this is
 * forensic-only so the collision is benign. DO NOT introduce codeSha-based
 * caching without also hashing the fetched bytes (or pinning via versionId).
 */
export function computeAnalyzeImageSha(
  imageUrl: string,
  prompt: string,
  maxTokens: number,
): string {
  const paramsStr = JSON.stringify({ prompt, max_tokens: maxTokens });
  return createHash("sha256").update(imageUrl + paramsStr).digest("hex");
}

// ─── Tool-run forensic insert ────────────────────────────────────────────

/**
 * Shared context shape. Same as `RunCodeContext` but re-declared here to
 * keep analyze_image independent of run-code's module (avoid circular
 * imports once registry adds both).
 */
export interface AnalyzeImageContext {
  userId: number;
  agentId?: number | null;
  meetingId?: string | null;
  turnId?: string | null;
  /** Same per-turn sandbox key convention as run_code. */
  ctxKey: SandboxKey;
}

export interface AnalyzeImageRunnerInput {
  image_url: string;
  prompt: string;
  max_tokens: number;
  timeout_ms: number;
}

export async function insertPendingAnalyzeImageRun(
  ctx: AnalyzeImageContext,
  input: AnalyzeImageRunnerInput,
  codeSha: string,
): Promise<void> {
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_analyze_image",
    codeSha,
    status: "pending",
    input: input as unknown as Record<string, unknown>,
    output: null,
    errorDetail: null,
    elapsedMs: null,
    memoryPeakBytes: null,
    networkAttempted: true, // SF4-fenced but real egress.
  });
}

export interface AnalyzeImageTerminalInfo {
  status: "ok" | "error" | "timeout";
  description?: string;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs: number;
  errorDetail?: string;
}

export async function insertTerminalAnalyzeImageRun(
  ctx: AnalyzeImageContext,
  input: AnalyzeImageRunnerInput,
  codeSha: string,
  info: AnalyzeImageTerminalInfo,
): Promise<void> {
  const output =
    info.status === "ok"
      ? ({
          description: info.description,
          stop_reason: info.stopReason,
          input_tokens: info.inputTokens,
          output_tokens: info.outputTokens,
          elapsed_ms: info.elapsedMs,
        } as unknown as Record<string, unknown>)
      : null;
  await db.insert(toolRuns).values({
    userId: ctx.userId,
    agentId: ctx.agentId ?? null,
    meetingId: ctx.meetingId ?? null,
    turnId: ctx.turnId ?? null,
    ctxKey: ctx.ctxKey,
    tool: "luca_analyze_image",
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

// ─── Main handler ────────────────────────────────────────────────────────

export interface AnalyzeImageToolResult {
  status: "ok" | "error" | "timeout" | "disabled";
  description: string;
  /** "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | undefined */
  stop_reason?: string;
  tokens_used?: number;
  error?: string;
}

export interface AnalyzeImageDeps {
  anthropicClient?: Anthropic;
  /** Override image fetch for tests. */
  fetchFn?: typeof fetchImageForAnthropic;
}

/**
 * Invoke the tool. Returns the user-facing result shape.
 *
 * Pass-2 finding H (Day 5 TOOL_TRUST_POLICY): `luca_analyze_image` is read-
 * only but fetches external content (Anthropic Vision reads the image,
 * including any text pixels). Treat as **UNTRUSTED** when Day 5 adds trust
 * enforcement — image contents can carry prompt-injection just like `read_url`.
 *
 * Pass-2 finding I.a (Day 4 followup): data: URIs are preserved verbatim in
 * `tool_runs.input` — a 10MB image lands directly in the JSONB row. Replace
 * with a `{type:'data-uri', sha256, size}` stub before insert to keep the
 * forensic log lean (codeSha already covers SF3 identity).
 */
export async function analyzeImageHandler(
  raw: unknown,
  ctx: AnalyzeImageContext,
  deps: AnalyzeImageDeps = {},
): Promise<AnalyzeImageToolResult> {
  // Three-level flag check first — no tool_runs row if tool shouldn't exist.
  if (!isLucaToolEnabled("LUCA_TOOL_ANALYZE_IMAGE_ENABLED")) {
    return {
      status: "disabled",
      description: "",
      error: "luca_feature_disabled: analyze_image tool is not enabled",
    };
  }

  const input = parseAnalyzeImageInput(raw);

  // SF4 URL validation BEFORE any network/DB work. Fail-closed on bad URL.
  const sf4 = validateImageUrlSF4(input.image_url);
  if (!sf4.ok) {
    return {
      status: "error",
      description: "",
      error: sf4.reason ?? "analyze_image.sf4: URL rejected",
    };
  }

  // Resolve effective params.
  // Fix A (Day 3 pass-1): normalize empty/whitespace prompt to DEFAULT_PROMPT.
  // Nullish-coalesce (??) alone lets "" through → Anthropic receives an empty
  // text block, 400s or returns unclear garbage. Trim + falsy-check forces
  // the default describe-this-image intent.
  const promptRaw = input.prompt ?? DEFAULT_PROMPT;
  const promptTrimmed = promptRaw.trim();
  const prompt = promptTrimmed.length > 0 ? promptTrimmed : DEFAULT_PROMPT;
  const maxTokens = Math.min(
    input.max_tokens ?? ANALYZE_IMAGE_DEFAULT_MAX_TOKENS,
    ANALYZE_IMAGE_MAX_MAX_TOKENS,
  );
  const timeoutMs = Math.min(
    input.timeout_ms ?? ANALYZE_IMAGE_DEFAULT_TIMEOUT_MS,
    ANALYZE_IMAGE_MAX_TIMEOUT_MS,
  );

  const codeSha = computeAnalyzeImageSha(input.image_url, prompt, maxTokens);
  const runnerInput: AnalyzeImageRunnerInput = {
    image_url: input.image_url,
    prompt,
    max_tokens: maxTokens,
    timeout_ms: timeoutMs,
  };

  // Pending row BEFORE fetch/API.
  try {
    await insertPendingAnalyzeImageRun(ctx, runnerInput, codeSha);
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.analyzeImage] failed to insert pending tool_runs row",
    );
    // Proceed — terminal row will still be attempted.
  }

  const startedAt = Date.now();

  // Fetch image. Timeout budget is SHARED between fetch and Anthropic call
  // — give fetch up to half the budget; leave the rest for Anthropic.
  const fetchBudgetMs = Math.max(1_000, Math.floor(timeoutMs / 2));
  let fetched: FetchedImage;
  try {
    const fetchFn = deps.fetchFn ?? fetchImageForAnthropic;
    fetched = await fetchFn(sf4.fetchUrl!, fetchBudgetMs, sf4.isDataUri === true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const elapsedMs = Date.now() - startedAt;
    const isTimeout = msg.includes("timeout");
    const status: "timeout" | "error" = isTimeout ? "timeout" : "error";
    logger.warn(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.analyzeImage] image fetch failed",
    );
    try {
      await insertTerminalAnalyzeImageRun(ctx, runnerInput, codeSha, {
        status,
        elapsedMs,
        errorDetail: msg,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.analyzeImage] failed to insert terminal tool_runs row after fetch fail",
      );
    }
    return {
      status,
      description: "",
      error: msg,
    };
  }

  // Build Anthropic client.
  const client =
    deps.anthropicClient ??
    (process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null);
  if (!client) {
    const elapsedMs = Date.now() - startedAt;
    const errorDetail =
      "analyze_image.config: ANTHROPIC_API_KEY not configured";
    try {
      await insertTerminalAnalyzeImageRun(ctx, runnerInput, codeSha, {
        status: "error",
        elapsedMs,
        errorDetail,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.analyzeImage] failed to insert terminal row after missing API key",
      );
    }
    return { status: "error", description: "", error: errorDetail };
  }

  // Remaining budget for Anthropic call.
  const elapsedBeforeApi = Date.now() - startedAt;
  const anthropicBudgetMs = Math.max(1_000, timeoutMs - elapsedBeforeApi);

  // Call Anthropic behind the breaker + our own timeout.
  let apiResp: Anthropic.Messages.Message;
  try {
    apiResp = await withAnthropicBreaker(client, (c) => {
      const apiCtl = new AbortController();
      const apiTimer = setTimeout(() => apiCtl.abort(), anthropicBudgetMs);
      return c.messages
        .create(
          {
            model: VISION_MODEL,
            max_tokens: maxTokens,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type:
                        fetched.mediaType as Anthropic.Messages.Base64ImageSource["media_type"],
                      data: fetched.base64,
                    },
                  },
                  { type: "text", text: prompt },
                ],
              },
            ],
          },
          { signal: apiCtl.signal },
        )
        .finally(() => clearTimeout(apiTimer));
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const elapsedMs = Date.now() - startedAt;
    // Distinguish: AbortError → timeout. Everything else → error.
    const aborted =
      e instanceof Error &&
      (e.name === "AbortError" || /aborted|timeout/i.test(msg));
    const status: "timeout" | "error" = aborted ? "timeout" : "error";
    logger.warn(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.analyzeImage] Anthropic call failed",
    );
    try {
      await insertTerminalAnalyzeImageRun(ctx, runnerInput, codeSha, {
        status,
        elapsedMs,
        errorDetail: msg,
      });
    } catch (logErr) {
      logger.error(
        { err: logErr, ctxKey: ctx.ctxKey, codeSha },
        "[luca.analyzeImage] failed to insert terminal row after API fail",
      );
    }
    return {
      status,
      description: "",
      error: msg,
    };
  }

  // Extract text from response. Anthropic returns a list of content blocks;
  // vision responses typically have a single text block but we concatenate
  // all text blocks defensively.
  const textBlocks = apiResp.content.filter(
    (b): b is Anthropic.Messages.TextBlock => b.type === "text",
  );
  const description = textBlocks.map((b) => b.text).join("\n\n");

  const elapsedMs = Date.now() - startedAt;
  try {
    await insertTerminalAnalyzeImageRun(ctx, runnerInput, codeSha, {
      status: "ok",
      description,
      stopReason: apiResp.stop_reason ?? undefined,
      inputTokens: apiResp.usage.input_tokens,
      outputTokens: apiResp.usage.output_tokens,
      elapsedMs,
    });
  } catch (e) {
    logger.error(
      { err: e, ctxKey: ctx.ctxKey, codeSha },
      "[luca.analyzeImage] failed to insert terminal tool_runs row on success",
    );
    // Forensic loss but result is valid, return to Luca.
  }

  return {
    status: "ok",
    description,
    stop_reason: apiResp.stop_reason ?? undefined,
    tokens_used:
      (apiResp.usage.input_tokens ?? 0) + (apiResp.usage.output_tokens ?? 0),
  };
}

// ─── Convenience re-exports ──────────────────────────────────────────────

export { LucaFeatureDisabledError };

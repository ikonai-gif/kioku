/**
 * Luca V1a env var placeholders.
 *
 * Day -1 scaffolding: these are READ by Luca modules but until
 * `LUCA_V1A_ENABLED=true` and the individual vars are populated at runtime,
 * every Luca code path short-circuits to a "disabled" response.
 *
 * Nothing in this file fails hard on missing values — that would break
 * deployments that don't use Luca yet. Individual feature modules decide how
 * to behave when their specific var is absent (e.g. drive_save_file logs
 * warn and throws `LucaFeatureDisabledError` if `LUCA_DRIVE_ROOT_FOLDER`
 * is unset).
 *
 * Kept separate from `process.env` access scattered across modules so we have
 * a single inventory of what Luca needs. `isLucaEnabled()` is the canonical
 * master switch — check it first in every tool handler.
 */

export interface LucaEnv {
  /**
   * Master feature flag. When false, Luca tools register as no-ops / refuse
   * to execute. Turn on only when every Day -1..10 PR is merged AND Kote
   * has populated the other vars below.
   */
  LUCA_V1A_ENABLED: boolean;

  /** Private S3 bucket, presigned-only. For plots, caches, embeddings. */
  LUCA_S3_BUCKET: string | null;

  /** AWS region for SF4 regional S3 URL whitelist in analyze_image. */
  AWS_REGION: string | null;

  /**
   * Google Drive folder id that is the root of Luca's workspace.
   * Every drive_save_file call must resolve to a folder that is THIS folder
   * or a descendant. Enforced by SF5 sanity fence.
   */
  LUCA_DRIVE_ROOT_FOLDER: string | null;

  /** Brave Search API key. Day 5. */
  BRAVE_SEARCH_API_KEY: string | null;

  /**
   * Second-level master: enables the tool REGISTRY (Day 2+). Default false.
   * Belt-and-braces — even if LUCA_V1A_ENABLED=true, tools don't ship unless
   * this is also on. Lets ops enable runtime-only (WS, chat) without the
   * tool surface while we debug individual tools.
   */
  LUCA_TOOLS_ENABLED: boolean;

  /** Per-tool flags. Default false. All require LUCA_TOOLS_ENABLED=true. */
  LUCA_TOOL_RUN_CODE_ENABLED: boolean;
  LUCA_TOOL_ANALYZE_IMAGE_ENABLED: boolean;
  LUCA_TOOL_SEARCH_ENABLED: boolean;
  // Day 5 — untrusted-by-policy (TOOL_TRUST_POLICY). Flag reserved now so
  // Day 5 PR can register without touching env.ts / isLucaToolEnabled union.
  LUCA_TOOL_READ_URL_ENABLED: boolean;
  LUCA_TOOL_READ_MEMORY_ENABLED: boolean;
  LUCA_TOOL_WRITE_MEMORY_ENABLED: boolean;
  LUCA_TOOL_READ_FILE_ENABLED: boolean;
  LUCA_TOOL_UPLOAD_FILE_ENABLED: boolean;
}

export function readLucaEnv(): LucaEnv {
  return {
    LUCA_V1A_ENABLED: process.env.LUCA_V1A_ENABLED === "true",
    // Fix C (Day 3 pass-1): normalize bucket to lowercase at read time.
    // AWS S3 bucket names are DNS-compliant and always lowercase; ops may
    // misconfigure with uppercase and we don't want SF4 to reject legitimate
    // URLs with confusing "bucket not allowed" errors. Empty string → null.
    LUCA_S3_BUCKET: (process.env.LUCA_S3_BUCKET ?? "").toLowerCase().trim() || null,
    AWS_REGION: process.env.AWS_REGION ?? null,
    LUCA_DRIVE_ROOT_FOLDER: process.env.LUCA_DRIVE_ROOT_FOLDER ?? null,
    BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY ?? null,
    LUCA_TOOLS_ENABLED: process.env.LUCA_TOOLS_ENABLED === "true",
    LUCA_TOOL_RUN_CODE_ENABLED: process.env.LUCA_TOOL_RUN_CODE_ENABLED === "true",
    LUCA_TOOL_ANALYZE_IMAGE_ENABLED: process.env.LUCA_TOOL_ANALYZE_IMAGE_ENABLED === "true",
    LUCA_TOOL_SEARCH_ENABLED: process.env.LUCA_TOOL_SEARCH_ENABLED === "true",
    LUCA_TOOL_READ_URL_ENABLED: process.env.LUCA_TOOL_READ_URL_ENABLED === "true",
    LUCA_TOOL_READ_MEMORY_ENABLED: process.env.LUCA_TOOL_READ_MEMORY_ENABLED === "true",
    LUCA_TOOL_WRITE_MEMORY_ENABLED: process.env.LUCA_TOOL_WRITE_MEMORY_ENABLED === "true",
    LUCA_TOOL_READ_FILE_ENABLED: process.env.LUCA_TOOL_READ_FILE_ENABLED === "true",
    LUCA_TOOL_UPLOAD_FILE_ENABLED: process.env.LUCA_TOOL_UPLOAD_FILE_ENABLED === "true",
  };
}

/**
 * Is a specific tool enabled? Requires BOTH master + tools-master + per-tool.
 * Three-level flag defense — any one of them off disables the tool.
 */
export function isLucaToolEnabled(
  toolFlag:
    | "LUCA_TOOL_RUN_CODE_ENABLED"
    | "LUCA_TOOL_ANALYZE_IMAGE_ENABLED"
    | "LUCA_TOOL_SEARCH_ENABLED"
    | "LUCA_TOOL_READ_URL_ENABLED"
    | "LUCA_TOOL_READ_MEMORY_ENABLED"
    | "LUCA_TOOL_WRITE_MEMORY_ENABLED"
    | "LUCA_TOOL_READ_FILE_ENABLED"
    | "LUCA_TOOL_UPLOAD_FILE_ENABLED",
): boolean {
  const env = readLucaEnv();
  return env.LUCA_V1A_ENABLED && env.LUCA_TOOLS_ENABLED && env[toolFlag];
}

export function isLucaEnabled(): boolean {
  return readLucaEnv().LUCA_V1A_ENABLED;
}

/**
 * Thrown when a Luca tool is invoked but the master flag is off or a
 * required env var is missing. Propagate to the tool-runner; it converts
 * to a user-visible "luca_feature_disabled" error.
 */
export class LucaFeatureDisabledError extends Error {
  constructor(public readonly reason: string) {
    super(`luca_feature_disabled: ${reason}`);
    this.name = "LucaFeatureDisabledError";
  }
}

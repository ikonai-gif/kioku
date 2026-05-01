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
   * Dev/staging escape hatch for SF4. When true, `validateImageUrlSF4`
   * additionally accepts arbitrary https:// hosts (still blocking
   * localhost / private IP ranges to prevent SSRF). Default false.
   * Set ONLY in non-prod when S3 is not configured but Luca needs to
   * analyze publicly-hosted images for smoke tests.
   */
  LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC: boolean;

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
  /**
   * Per-tool flag for `luca_agent_browser`. Default false (ship-dark).
   * Boss flips manually after BRO3 mock smoke. See
   * server/lib/luca-tools/agent-browser.ts for the full defense stack.
   */
  LUCA_TOOL_AGENT_BROWSER_ENABLED: boolean;
  LUCA_TOOL_READ_MEMORY_ENABLED: boolean;
  LUCA_TOOL_WRITE_MEMORY_ENABLED: boolean;
  LUCA_TOOL_READ_FILE_ENABLED: boolean;
  LUCA_TOOL_UPLOAD_FILE_ENABLED: boolean;

  // ── Step 4 (Gmail scope) ──────────────────────────────────────────
  /**
   * Scope-level master for Gmail tools (read + future action + send). When
   * false, every Gmail tool (`luca_inbox_list`, `luca_email_read`,
   * `luca_email_thread`, future `luca_email_action` / `luca_email_send`)
   * is invisible to Luca and refuses to execute. Lets ops flip the whole
   * scope on/off in one switch without touching per-tool flags.
   *
   * Orthogonal to LUCA_EXPANDED_SCOPE_ENABLED: expanded-scope flips the
   * Studio name admission list for the legacy tool names (memory tools),
   * this flag gates the new `luca_*` email tools. A customer can have
   * Gmail scope on without expanded-scope, or vice-versa.
   */
  LUCA_EMAIL_SCOPE_ENABLED: boolean;
  /** Per-tool flag for the email read family (inbox_list/read/thread). */
  LUCA_TOOL_EMAIL_READ_ENABLED: boolean;

  // Day 6 — approval gate. When LUCA_APPROVAL_GATE_ENABLED=true, the
  // middleware intercepts HIGH_STAKES_WRITE tool calls (see
  // server/lib/luca-approvals/classify.ts) and inserts a pending row
  // in tool_approvals; Luca receives `{status:"pending_approval",...}`
  // instead of running the tool. Default false.
  LUCA_APPROVAL_GATE_ENABLED: boolean;
  /**
   * Shadow-mode control (Luca's suggestion). When "log_only" the gate
   * classifies and logs every HIGH call but still executes it — lets us
   * observe real traffic without blocking Luca in prod. When "block" the
   * gate enforces (pending-approval pathway). Default "block".
   */
  LUCA_APPROVAL_GATE_MODE: "log_only" | "block";
  /**
   * When true, the expanded Luca tool scope (Gmail 12 + cloud reads +
   * schedule/set_reminder — Day 6 part 3) is admitted into
   * LUCA_STUDIO_TOOL_NAMES. Orthogonal to the gate: expanded scope is
   * safe only when APPROVAL_GATE_ENABLED=true, so startup fails fast if
   * EXPANDED=true && GATE=false.
   */
  LUCA_EXPANDED_SCOPE_ENABLED: boolean;

  // ── LEO PR-A — Luca Event-Driven Outreach (Telegram tool) ─────────────
  // None of these are connected to a master flag yet; the tool itself
  // returns `{ok:false, error:'telegram_not_configured'}` when token/chat
  // are unset. Kept additive — turning them on requires no other change.
  /**
   * Raw quiet-hours window, e.g. "22:00-08:00". Default "22:00-08:00";
   * `parseQuietHours` returns null when this is empty/malformed and the
   * dispatcher then skips the quiet-hours check entirely.
   */
  LUCA_QUIET_HOURS: string | null;
  /** IANA timezone for quiet-hours arithmetic. Default America/Los_Angeles. */
  LUCA_QUIET_HOURS_TZ: string;
  /** Anthropic model for the urgency classifier. Default claude-haiku-4-5. */
  LUCA_URGENCY_MODEL: string;
  /** Comma-separated list of VIP sender emails (case-insensitive match). */
  LUCA_VIP_SENDERS: string[];
  /** Telegram Bot API token (from @BotFather). Null disables Telegram tool. */
  TELEGRAM_BOT_TOKEN: string | null;
  /** Telegram chat_id for BOSS. Null disables Telegram tool. */
  TELEGRAM_BOSS_CHAT_ID: string | null;
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
    LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC:
      process.env.LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC === "true",
    LUCA_DRIVE_ROOT_FOLDER: process.env.LUCA_DRIVE_ROOT_FOLDER ?? null,
    BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY ?? null,
    LUCA_TOOLS_ENABLED: process.env.LUCA_TOOLS_ENABLED === "true",
    LUCA_TOOL_RUN_CODE_ENABLED: process.env.LUCA_TOOL_RUN_CODE_ENABLED === "true",
    LUCA_TOOL_ANALYZE_IMAGE_ENABLED: process.env.LUCA_TOOL_ANALYZE_IMAGE_ENABLED === "true",
    LUCA_TOOL_SEARCH_ENABLED: process.env.LUCA_TOOL_SEARCH_ENABLED === "true",
    LUCA_TOOL_READ_URL_ENABLED: process.env.LUCA_TOOL_READ_URL_ENABLED === "true",
    LUCA_TOOL_AGENT_BROWSER_ENABLED:
      process.env.LUCA_TOOL_AGENT_BROWSER_ENABLED === "true",
    LUCA_TOOL_READ_MEMORY_ENABLED: process.env.LUCA_TOOL_READ_MEMORY_ENABLED === "true",
    LUCA_TOOL_WRITE_MEMORY_ENABLED: process.env.LUCA_TOOL_WRITE_MEMORY_ENABLED === "true",
    LUCA_TOOL_READ_FILE_ENABLED: process.env.LUCA_TOOL_READ_FILE_ENABLED === "true",
    LUCA_TOOL_UPLOAD_FILE_ENABLED: process.env.LUCA_TOOL_UPLOAD_FILE_ENABLED === "true",
    LUCA_EMAIL_SCOPE_ENABLED: process.env.LUCA_EMAIL_SCOPE_ENABLED === "true",
    LUCA_TOOL_EMAIL_READ_ENABLED: process.env.LUCA_TOOL_EMAIL_READ_ENABLED === "true",
    LUCA_APPROVAL_GATE_ENABLED: process.env.LUCA_APPROVAL_GATE_ENABLED === "true",
    // Mode defaults to "block" — when the flag is on, enforce. "log_only"
    // is opt-in via explicit value. Any unrecognized value falls back to
    // "block" (fail-safe: prefer over-blocking to under-blocking).
    LUCA_APPROVAL_GATE_MODE:
      process.env.LUCA_APPROVAL_GATE_MODE === "log_only" ? "log_only" : "block",
    LUCA_EXPANDED_SCOPE_ENABLED: process.env.LUCA_EXPANDED_SCOPE_ENABLED === "true",
    // LEO PR-A — additive, no consistency rules. Tool gates itself on
    // missing token/chat at call time.
    LUCA_QUIET_HOURS: (process.env.LUCA_QUIET_HOURS ?? "").trim() || "22:00-08:00",
    LUCA_QUIET_HOURS_TZ: (process.env.LUCA_QUIET_HOURS_TZ ?? "").trim() || "America/Los_Angeles",
    LUCA_URGENCY_MODEL: (process.env.LUCA_URGENCY_MODEL ?? "").trim() || "claude-haiku-4-5",
    LUCA_VIP_SENDERS: (process.env.LUCA_VIP_SENDERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
    TELEGRAM_BOT_TOKEN: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim() || null,
    TELEGRAM_BOSS_CHAT_ID: (process.env.TELEGRAM_BOSS_CHAT_ID ?? "").trim() || null,
  };
}

/**
 * Startup fail-fast check. Call from server boot AFTER env is loaded but
 * BEFORE request handlers bind. Throws if the config is internally
 * inconsistent — catches e.g. "expanded scope on but gate off" which
 * would expose un-gated Gmail/Drive writes.
 *
 * Rules:
 *   - LUCA_EXPANDED_SCOPE_ENABLED=true REQUIRES LUCA_APPROVAL_GATE_ENABLED=true.
 *   - LUCA_APPROVAL_GATE_ENABLED=true REQUIRES LUCA_V1A_ENABLED=true.
 *     (Gate uses Luca's execution path; no sense enabling it if the
 *     master is off.)
 */
export function assertLucaEnvConsistency(env: LucaEnv = readLucaEnv()): void {
  if (env.LUCA_EXPANDED_SCOPE_ENABLED && !env.LUCA_APPROVAL_GATE_ENABLED) {
    throw new Error(
      "luca_env_inconsistent: LUCA_EXPANDED_SCOPE_ENABLED=true requires LUCA_APPROVAL_GATE_ENABLED=true " +
        "(expanded scope adds Gmail/Drive/GitHub writes; disabling the gate would let Luca send without confirmation)",
    );
  }
  if (env.LUCA_APPROVAL_GATE_ENABLED && !env.LUCA_V1A_ENABLED) {
    throw new Error(
      "luca_env_inconsistent: LUCA_APPROVAL_GATE_ENABLED=true requires LUCA_V1A_ENABLED=true",
    );
  }
}

/** Is the approval gate live and enforcing? */
export function isApprovalGateEnforcing(): boolean {
  const env = readLucaEnv();
  return env.LUCA_APPROVAL_GATE_ENABLED && env.LUCA_APPROVAL_GATE_MODE === "block";
}

/** Is the gate doing anything at all (log_only or block)? */
export function isApprovalGateActive(): boolean {
  return readLucaEnv().LUCA_APPROVAL_GATE_ENABLED;
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
    | "LUCA_TOOL_AGENT_BROWSER_ENABLED"
    | "LUCA_TOOL_READ_MEMORY_ENABLED"
    | "LUCA_TOOL_WRITE_MEMORY_ENABLED"
    | "LUCA_TOOL_READ_FILE_ENABLED"
    | "LUCA_TOOL_UPLOAD_FILE_ENABLED"
    | "LUCA_TOOL_EMAIL_READ_ENABLED",
): boolean {
  const env = readLucaEnv();
  return env.LUCA_V1A_ENABLED && env.LUCA_TOOLS_ENABLED && env[toolFlag];
}

/**
 * Four-level flag check for the Gmail scope: master → tools-master →
 * email-scope → per-tool. Adds one extra switch over `isLucaToolEnabled`
 * so ops can kill the entire Gmail surface without disabling non-email
 * Luca tools.
 */
export function isLucaEmailToolEnabled(
  toolFlag: "LUCA_TOOL_EMAIL_READ_ENABLED",
): boolean {
  const env = readLucaEnv();
  return (
    env.LUCA_V1A_ENABLED &&
    env.LUCA_TOOLS_ENABLED &&
    env.LUCA_EMAIL_SCOPE_ENABLED &&
    env[toolFlag]
  );
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

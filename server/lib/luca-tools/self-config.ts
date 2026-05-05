// R464 / luca_self_config — read-only introspection of Luca's own runtime
// configuration. Phase 1 of the Luca-autonomy plan: lets Luca see her own
// feature flags, available tool list, and which secrets are configured by
// NAME ONLY (never values), so she stops guessing about her own state.
//
// Honesty driver: today's partner-chat (2026-05-04) showed Luca flipping her
// answer about `luca_search` three times in one conversation — not because she
// lied, but because she has no way to read her own config. This tool fixes
// that gap.
//
// Scope:
//   - read-only, NO writes, NO mutations
//   - no PII / no secrets returned — only flag booleans, env-var presence,
//     and tool-name lists. Secret VALUES are never exposed; only
//     `present: true|false` per known key.
//   - per-call: zero parameters from input. All state is derived from
//     server env + registry — this is the same data Luca's own runtime
//     uses to decide whether to admit a tool, so showing it to her cannot
//     leak anything she doesn't already implicitly use.
//
// What it returns (frozen v1 shape):
//   {
//     master_flags: { LUCA_V1A_ENABLED, LUCA_TOOLS_ENABLED, LUCA_EMAIL_SCOPE_ENABLED,
//                     LUCA_EXPANDED_SCOPE_ENABLED, LUCA_APPROVAL_GATE_ENABLED,
//                     LUCA_APPROVAL_GATE_MODE, LUCA_PROMPT_CACHING_ENABLED },
//     tool_flags:   { LUCA_TOOL_*_ENABLED → boolean (effective: ALL gates AND'd) },
//     secrets_present: { BRAVE_SEARCH_API_KEY: true|false, ... },  // names only
//     studio_tools: { base: string[], expanded: string[] | null, effective: string[] },
//     quiet_hours:  { window: "22:00-08:00", tz: "America/Los_Angeles" },
//     spec_version: "self_config@1",
//   }
//
// Rate-limit: 20/hour per agentId via existing checkAuthRateLimit (R438
// lesson — reuse, don't plumb new limiters). Burst 5/min.

import { readLucaEnv, isLucaToolEnabled, isLucaEmailToolEnabled } from "../luca/env";

export interface SelfConfigSnapshot {
  master_flags: {
    LUCA_V1A_ENABLED: boolean;
    LUCA_TOOLS_ENABLED: boolean;
    LUCA_EMAIL_SCOPE_ENABLED: boolean;
    LUCA_EXPANDED_SCOPE_ENABLED: boolean;
    LUCA_APPROVAL_GATE_ENABLED: boolean;
    LUCA_APPROVAL_GATE_MODE: "log_only" | "block";
    LUCA_PROMPT_CACHING_ENABLED: boolean;
    LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC: boolean;
  };
  /** Effective per-tool: TRUE only when master + tools-master + per-tool all true. */
  tool_flags: Record<string, boolean>;
  /** Names of known secret env vars and whether they are configured (non-empty). NEVER values. */
  secrets_present: Record<string, boolean>;
  studio_tools: {
    /** Names admitted in BASE scope (always-on subset). */
    base: readonly string[];
    /**
     * Names admitted in EXPANDED scope. Null when LUCA_EXPANDED_SCOPE_ENABLED=false
     * (signals: "expanded surface exists but is currently inactive").
     */
    expanded: readonly string[] | null;
    /** Effective union — what Luca's runtime actually admits right now. */
    effective: readonly string[];
  };
  quiet_hours: {
    window: string;
    tz: string;
  };
  spec_version: "self_config@1";
}

/**
 * Build a self-config snapshot. Pure function over env + supplied tool-name
 * lists — no DB, no network. Caller (deliberation.ts case "luca_self_config")
 * passes the studio tool name lists so we don't pull in the deliberation
 * import graph from this leaf module.
 */
export function buildSelfConfigSnapshot(input: {
  baseToolNames: readonly string[];
  expandedToolNames: readonly string[];
  /** True iff EXPANDED is currently active (LUCA_EXPANDED_SCOPE_ENABLED). */
  expandedActive: boolean;
}): SelfConfigSnapshot {
  const env = readLucaEnv();

  const tool_flags: Record<string, boolean> = {
    LUCA_TOOL_RUN_CODE_ENABLED: isLucaToolEnabled("LUCA_TOOL_RUN_CODE_ENABLED"),
    LUCA_TOOL_ANALYZE_IMAGE_ENABLED: isLucaToolEnabled("LUCA_TOOL_ANALYZE_IMAGE_ENABLED"),
    LUCA_TOOL_SEARCH_ENABLED: isLucaToolEnabled("LUCA_TOOL_SEARCH_ENABLED"),
    LUCA_TOOL_READ_URL_ENABLED: isLucaToolEnabled("LUCA_TOOL_READ_URL_ENABLED"),
    LUCA_TOOL_AGENT_BROWSER_ENABLED: isLucaToolEnabled("LUCA_TOOL_AGENT_BROWSER_ENABLED"),
    LUCA_TOOL_READ_MEMORY_ENABLED: isLucaToolEnabled("LUCA_TOOL_READ_MEMORY_ENABLED"),
    LUCA_TOOL_WRITE_MEMORY_ENABLED: isLucaToolEnabled("LUCA_TOOL_WRITE_MEMORY_ENABLED"),
    LUCA_TOOL_READ_FILE_ENABLED: isLucaToolEnabled("LUCA_TOOL_READ_FILE_ENABLED"),
    LUCA_TOOL_UPLOAD_FILE_ENABLED: isLucaToolEnabled("LUCA_TOOL_UPLOAD_FILE_ENABLED"),
    // Email-read uses the four-level gate (adds LUCA_EMAIL_SCOPE_ENABLED).
    LUCA_TOOL_EMAIL_READ_ENABLED: isLucaEmailToolEnabled("LUCA_TOOL_EMAIL_READ_ENABLED"),
  };

  // Secret presence — NAMES ONLY. Do NOT inline values, do NOT log values.
  // Known list maintained here; if a secret name is added in env.ts, add it here too.
  const secretKeys = [
    "BRAVE_SEARCH_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOSS_CHAT_ID",
    "LUCA_S3_BUCKET",
    "LUCA_DRIVE_ROOT_FOLDER",
    "AWS_REGION",
  ] as const;
  const secrets_present: Record<string, boolean> = {};
  for (const k of secretKeys) {
    const v = (process.env[k] ?? "").trim();
    secrets_present[k] = v.length > 0;
  }

  return {
    master_flags: {
      LUCA_V1A_ENABLED: env.LUCA_V1A_ENABLED,
      LUCA_TOOLS_ENABLED: env.LUCA_TOOLS_ENABLED,
      LUCA_EMAIL_SCOPE_ENABLED: env.LUCA_EMAIL_SCOPE_ENABLED,
      LUCA_EXPANDED_SCOPE_ENABLED: env.LUCA_EXPANDED_SCOPE_ENABLED,
      LUCA_APPROVAL_GATE_ENABLED: env.LUCA_APPROVAL_GATE_ENABLED,
      LUCA_APPROVAL_GATE_MODE: env.LUCA_APPROVAL_GATE_MODE,
      LUCA_PROMPT_CACHING_ENABLED: env.LUCA_PROMPT_CACHING_ENABLED,
      LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC: env.LUCA_ANALYZE_IMAGE_ALLOW_PUBLIC,
    },
    tool_flags,
    secrets_present,
    studio_tools: {
      base: input.baseToolNames,
      expanded: input.expandedActive ? input.expandedToolNames : null,
      effective: input.expandedActive
        ? [...input.baseToolNames, ...input.expandedToolNames]
        : [...input.baseToolNames],
    },
    quiet_hours: {
      window: env.LUCA_QUIET_HOURS ?? "22:00-08:00",
      tz: env.LUCA_QUIET_HOURS_TZ,
    },
    spec_version: "self_config@1",
  };
}

/**
 * Luca Day 6 — TOOL_WRITE_CLASS.
 *
 * Classifies every tool Luca can invoke into one of three risk tiers that
 * drive the approval-gate middleware:
 *
 *   READ_ONLY          — No external side-effects. Tool only reads (API GET,
 *                        DB SELECT, sandbox compute). No approval needed.
 *                        UNTRUSTED content may still be returned — that's
 *                        orthogonal (trust-policy.ts handles it).
 *
 *   LOW_STAKES_WRITE   — Writes, but only to surfaces fully owned by Luca
 *                        himself (his own workspace subtree, his own memory,
 *                        his own series_bible doc, his own self-reminders).
 *                        Idempotent or trivially reversible. No approval,
 *                        but logged in tool_runs for audit.
 *
 *   HIGH_STAKES_WRITE  — Reaches the outside world or a user-shared surface:
 *                        sends email, writes to shared Drive/Sheets/Cal,
 *                        modifies external infra, spends money, schedules
 *                        future actions that will themselves have effects.
 *                        Middleware intercepts → creates `tool_approvals`
 *                        row → Kote decides Send/No/Edit.
 *
 * Fail-closed default: any tool NOT in the table classifies HIGH_STAKES_WRITE.
 * This is the safe direction — a newly added unclassified tool is treated
 * as dangerous until explicitly labelled. The alternative (default READ_ONLY)
 * would open a hole: forget to classify a tool, and it bypasses the gate.
 *
 * Some tools need sub-action classification — e.g. `composio_action` has
 * `action: "search" | "execute"`, where search is read-only but execute is
 * an arbitrary downstream call. `inbox_action` with `archive` is LOW while
 * other email actions may escalate. For those we expose `classifyToolCall`
 * which takes the full tool input; `classifyTool` by name alone answers
 * "what's the worst case this tool can do" (conservative upper bound).
 *
 * Why a table, not regex or heuristic:
 *   - Reviewable: every addition shows up as a diff with one class per line.
 *   - Typechecked: `satisfies Record<LucaToolName, ...>` on the table
 *     forces a class decision whenever `LucaToolName` grows.
 *   - Forensic: `classifyTool(name)` is pure — replaying an old turn
 *     produces the same class regardless of env flags or request shape.
 */

export type ToolWriteClass = "READ_ONLY" | "LOW_STAKES_WRITE" | "HIGH_STAKES_WRITE";

/**
 * Canonical list of Luca-admissible tool names (Studio + V1a).
 * Keep in sync with `LUCA_STUDIO_TOOL_NAMES` in server/deliberation.ts
 * and the V1a tool list in server/lib/luca-tools/trust-policy.ts.
 *
 * Tools NOT on this list are architecturally out-of-scope for Luca
 * (`sandbox_shell`, `delegate_task`, `composio_action`, `build_project`,
 * etc.) and are blocked by the Studio guard upstream — they never reach
 * the classifier. But we still list their entries in `UNADMITTED_TOOLS`
 * below so a test can prove the Studio whitelist and this table stay
 * aligned.
 */
export type LucaAdmissibleTool =
  // V1a agentic tools (all READ_ONLY from side-effect perspective)
  | "luca_run_code"
  | "luca_analyze_image"
  | "luca_search"
  | "luca_read_url"
  // Step 4 PR A — Luca-native Gmail read tools (READ_ONLY)
  | "luca_inbox_list"
  | "luca_email_read"
  | "luca_email_thread"
  // Media (15)
  | "generate_image"
  | "generate_video"
  | "generate_image_to_video"
  | "generate_speech"
  | "clone_voice"
  | "generate_sfx"
  | "generate_music"
  | "stitch_media"
  | "reframe_vertical"
  | "add_subtitles"
  | "add_title_cards"
  | "apply_ai_disclosure"
  | "series_bible"
  | "produce_episode"
  | "generate_document"
  // Workspace (3)
  | "workspace_list"
  | "workspace_save"
  | "workspace_read"
  // Self-memory (1)
  | "remember"
  // ── Day 6 scope expansion (gated behind LUCA_EXPANDED_SCOPE_ENABLED) ──
  // Gmail reads + triage
  | "gmail_search"
  | "gmail_read"
  | "gmail_accounts_status"
  | "gmail_reconnect_link"
  | "inbox_list"
  | "inbox_read"
  | "inbox_action"
  | "read_email_thread"
  | "search_emails"
  | "email_triage"
  // Gmail writes (HIGH_STAKES)
  | "send_email_reply"
  | "send_new_email"
  // Cloud file reads
  | "search_cloud_files"
  | "read_cloud_file"
  // Heavy produce (HIGH_STAKES — burns compute/$)
  | "produce_season"
  // Scheduling
  | "schedule_task"
  | "set_reminder"
  | "list_tasks";

/**
 * Primary classification table by tool name (worst-case upper bound).
 * For tools whose class depends on input (composio_action, inbox_action,
 * schedule_task with `action_type`), `classifyToolCall` reads the input
 * and may return a less severe class. By name alone we assume the worst.
 *
 * Rationale per bucket — NOT just comments, part of the review surface:
 */
export const TOOL_WRITE_CLASS = {
  // ─── V1a — sandboxed / whitelist-fenced reads ─────────────────────
  // Self-contained sandbox, no network egress. Pure compute.
  luca_run_code:        "READ_ONLY",
  // Anthropic Vision on a whitelisted image URL. Remote read, no writes.
  luca_analyze_image:   "READ_ONLY",
  // Brave Search API. Pure read of index + snippets.
  luca_search:          "READ_ONLY",
  // SSRF-fenced URL reader. HTTP GET with defenses; no side-effects.
  luca_read_url:        "READ_ONLY",

  // ─── Step 4 PR A — Luca-native Gmail reads ( READ_ONLY ) ──────────────
  // Same class as the legacy `inbox_list` / `inbox_read` / `read_email_thread`
  // names above: pure Gmail API GET calls, no label modification, no send.
  // Content is UNTRUSTED (trust-policy.ts) but that's orthogonal to the
  // write class — READ_ONLY is about side-effects, not about whether the
  // bytes are attacker-controlled.
  luca_inbox_list:      "READ_ONLY",
  luca_email_read:      "READ_ONLY",
  luca_email_thread:    "READ_ONLY",

  // ─── Media generation — LOW (costs some $$ but ephemeral URLs) ────
  // Returns data URI / signed URL to Luca. Kote sees output in chat.
  // No external recipient, reversible by "don't use it". Worst case:
  // Luca burns OpenAI/Stability credits on a bad prompt — acceptable
  // for creative iteration. If cost becomes a concern, promote these
  // to HIGH per-tool via flag without touching the gate machinery.
  generate_image:           "LOW_STAKES_WRITE",
  generate_video:           "LOW_STAKES_WRITE",
  generate_image_to_video:  "LOW_STAKES_WRITE",
  generate_speech:          "LOW_STAKES_WRITE",
  // clone_voice → HIGH (Luca N1 review): creates a persistent voice_id in
  // the ElevenLabs account tied to Kote's API key. Biometric data + un-
  // bounded retention is a different risk class than ephemeral TTS output.
  // Approval ensures Kote sees which voice is being cloned before the
  // ID is provisioned.
  clone_voice:              "HIGH_STAKES_WRITE",
  generate_sfx:             "LOW_STAKES_WRITE",
  generate_music:           "LOW_STAKES_WRITE",
  generate_document:        "LOW_STAKES_WRITE",
  // stitch_media / reframe / subtitles / title_cards / disclosure — pure
  // transforms over Luca's own prior outputs. No new external content.
  stitch_media:             "LOW_STAKES_WRITE",
  reframe_vertical:         "LOW_STAKES_WRITE",
  add_subtitles:            "LOW_STAKES_WRITE",
  add_title_cards:          "LOW_STAKES_WRITE",
  apply_ai_disclosure:      "LOW_STAKES_WRITE",
  // series_bible — Luca's own creative doc. LOW.
  series_bible:             "LOW_STAKES_WRITE",
  // produce_episode — reads bible + chains media tools. Each step LOW,
  // but the orchestrator can burn ~$X and minutes. Per plan §2: LOW
  // (episode = small enough). produce_season (not in current Studio
  // list but planned addition) → HIGH.
  produce_episode:          "LOW_STAKES_WRITE",
  produce_season:           "HIGH_STAKES_WRITE",  // $$$, hours compute

  // ─── Workspace — own subtree LOW, shared surface via save is HIGH  ─
  workspace_list:           "READ_ONLY",
  workspace_read:           "READ_ONLY",
  // NOTE: classifyToolCall inspects the `path` field. Writes to `/luca/*`
  // downgrade to LOW; writes elsewhere stay HIGH. Name-only answer is the
  // upper bound.
  workspace_save:           "HIGH_STAKES_WRITE",

  // ─── Self-memory — Luca's own authority, no approval ──────────────
  remember:                 "LOW_STAKES_WRITE",

  // ─── Gmail reads (content is UNTRUSTED — trust-policy handles that) ─
  gmail_search:             "READ_ONLY",
  gmail_read:                "READ_ONLY",
  gmail_accounts_status:    "READ_ONLY",
  gmail_reconnect_link:     "READ_ONLY",
  inbox_list:                "READ_ONLY",
  inbox_read:                "READ_ONLY",
  read_email_thread:        "READ_ONLY",
  search_emails:            "READ_ONLY",
  email_triage:             "READ_ONLY",
  // inbox_action has sub-actions: archive/mark_read/mark_unread are
  // idempotent + reversible on the owner's own inbox → LOW. Name-only
  // returns LOW because no sub-action of inbox_action is HIGH today.
  // Escalate here if inbox_action ever grows a 'delete' or 'forward'.
  inbox_action:             "LOW_STAKES_WRITE",

  // ─── Gmail writes — every send is an approval ─────────────────────
  send_email_reply:         "HIGH_STAKES_WRITE",
  send_new_email:           "HIGH_STAKES_WRITE",

  // ─── Cloud file reads (UNTRUSTED content) ─────────────────────────
  search_cloud_files:       "READ_ONLY",
  read_cloud_file:           "READ_ONLY",

  // ─── Scheduling — future side-effects classify as their own class ─
  // Today's rule (§2 plan): scheduling user-visible actions = HIGH (the
  // future action itself may be a send or write). Self-reminders are
  // LOW — they just flip a bit in Luca's own queue until they fire,
  // AT WHICH POINT the delivery tool (e.g. send_email) gets its own
  // approval anyway. So the layering holds.
  //
  // By-name returns HIGH (worst case schedule_task payload == send_email).
  // classifyToolCall downgrades self-reminders to LOW when action_type
  // is message-to-self or similar.
  schedule_task:            "HIGH_STAKES_WRITE",
  set_reminder:             "LOW_STAKES_WRITE",
  list_tasks:               "READ_ONLY",
} as const satisfies Record<LucaAdmissibleTool, ToolWriteClass>;

/**
 * Tools that DO exist in the partnerTools registry but are architecturally
 * NOT admissible for Luca. The Studio guard in `executePartnerTool`
 * (server/deliberation.ts:1255) rejects these before they reach the
 * classifier. We list them here so a unit test can assert the two sets
 * stay disjoint — if someone adds a name to both `LUCA_STUDIO_TOOL_NAMES`
 * AND this list, the test fails loudly.
 *
 * Reasons (condensed):
 *   - sandbox_* / create_file / read_file — dev-partner surface
 *   - delegate_* / plan_steps / build_project — Bro2 orchestration
 *   - composio_action — generic write gateway; can't classify statically
 *                       without sub-action inspection (see classifyToolCall)
 *   - creative_writing / learn_* / suggest_* / ask_feedback /
 *     read_own_prompt / update_self_knowledge / correct_false_memory /
 *     watch_video / listen_audio / browse_website — legacy / phantom,
 *     duplicates of native capability
 *   - web_search / read_url / run_code / analyze_image (NO prefix) —
 *     phantom duplicates of the V1a luca_-prefixed versions
 */
export const UNADMITTED_TOOLS: ReadonlySet<string> = new Set([
  "sandbox_shell",
  "sandbox_write_file",
  "sandbox_read_file",
  "sandbox_list_files",
  "sandbox_download",
  "reset_sandbox",
  "create_file",
  "read_file",
  "convert_file",
  "delegate_task",
  "delegate_parallel",
  "plan_steps",
  "build_project",
  "composio_action",
  "creative_writing",
  "learn_lesson",
  "learn_preference",
  "suggest_self_improvement",
  "suggest_proactively",
  "ask_feedback",
  "read_own_prompt",
  "update_self_knowledge",
  "correct_false_memory",
  "watch_video",
  "listen_audio",
  "browse_website",
  "web_search",
  "read_url",
  "run_code",
  "analyze_image",
]);

/**
 * Classify by name alone. Returns the worst-case class for this tool's
 * possible invocations. Used by middleware when it needs a fast upper-
 * bound decision (e.g. "do I even need to look at the payload?").
 *
 * Unknown tool → HIGH_STAKES_WRITE (fail-closed). Callers that want to
 * distinguish "unknown" from "known-HIGH" should use `isAdmissibleTool`.
 */
export function classifyTool(toolName: string): ToolWriteClass {
  if (toolName in TOOL_WRITE_CLASS) {
    return TOOL_WRITE_CLASS[toolName as LucaAdmissibleTool];
  }
  return "HIGH_STAKES_WRITE";
}

/** True iff the tool has an explicit classification entry. */
export function isAdmissibleTool(toolName: string): toolName is LucaAdmissibleTool {
  return toolName in TOOL_WRITE_CLASS;
}

/**
 * Input-aware classification. For tools whose class depends on payload
 * sub-action, inspects the input. For all others, falls back to
 * `classifyTool`. Returns the actual class this specific call will be
 * treated as by the gate.
 *
 * Known sub-action rules:
 *   - `workspace_save` with path starting "/luca/" → LOW; else HIGH.
 *   - `schedule_task` with action_type === "message" + recipient = self
 *     → LOW; else HIGH. (Conservative: if we can't tell, assume HIGH.)
 *   - `inbox_action` — all sub-actions today (mark_read/mark_unread/
 *     archive) are idempotent & reversible → LOW (same as by-name).
 *
 * Narrow input typing: accepts `unknown` because the gate middleware
 * threads the raw tool_input JSON. We validate shape defensively.
 */
export function classifyToolCall(toolName: string, toolInput: unknown): ToolWriteClass {
  const byName = classifyTool(toolName);

  // Only sub-action rules can DOWNGRADE the class. We never upgrade by
  // payload — if the by-name class is HIGH, it stays HIGH. This keeps
  // the gate permissive of LOW tools and strict about HIGH tools, with
  // specific documented exceptions below.
  if (byName !== "HIGH_STAKES_WRITE") {
    return byName;
  }

  if (!toolInput || typeof toolInput !== "object") {
    return byName;
  }
  const input = toolInput as Record<string, unknown>;

  // workspace_save — own subtree downgrade.
  if (toolName === "workspace_save") {
    const path = typeof input.path === "string" ? input.path : "";
    if (path.startsWith("/luca/")) {
      return "LOW_STAKES_WRITE";
    }
    return "HIGH_STAKES_WRITE";
  }

  // schedule_task — self-message downgrade. action_type === "message"
  // with no external recipient field is treated as self-reminder.
  // If in doubt, stay HIGH (safer).
  if (toolName === "schedule_task") {
    const actionType = typeof input.action_type === "string" ? input.action_type : "";
    // payload is a JSON string per tool schema; if we can parse it and
    // find no recipient/to/email/url field, treat as self-notify.
    let payload: Record<string, unknown> = {};
    if (typeof input.action_payload === "string") {
      try {
        const parsed = JSON.parse(input.action_payload);
        if (parsed && typeof parsed === "object") {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Unparseable payload → stay HIGH (conservative: maybe it sends somewhere).
        return "HIGH_STAKES_WRITE";
      }
    }
    const hasExternalTarget =
      "to" in payload ||
      "recipient" in payload ||
      "email" in payload ||
      "url" in payload ||
      "webhook" in payload;
    if (actionType === "message" && !hasExternalTarget) {
      return "LOW_STAKES_WRITE";
    }
    return "HIGH_STAKES_WRITE";
  }

  return byName;
}

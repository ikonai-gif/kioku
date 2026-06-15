/**
 * Tool whitelist for tool_observed provenance.
 *
 * When an agent calls `remember()` after invoking a tool listed here,
 * the memory's provenance is set to 'tool_observed' instead of 'luca_inferred'.
 * This signals that the fact was derived from real data the agent observed,
 * not from its parametric knowledge or inference alone.
 */

/** Logical tool names that count as "observed" data sources. */
export const TOOL_OBSERVED_WHITELIST: Set<string> = new Set([
  // NOTE: these are RUNTIME tool names as they appear in tool_activity_log,
  // NOT the names from tool definitions. The runtime prefixes several tools
  // with `luca_` (luca_read_url, luca_search, luca_analyze_image, ...) while
  // others carry no prefix (read_cloud_file, gmail_search, workspace_read).
  // Verified against production tool_activity_log 2026-06-15 (BRO2).
  // External data / search
  "luca_read_url",
  "luca_search",
  "luca_analyze_image",
  "watch_video",
  // Files / cloud
  "read_cloud_file",
  "search_cloud_files",
  "workspace_read",
  "workspace_list",
  // Email
  "gmail_search",
  "gmail_accounts_status",
  // Code / system / calendar
  "luca_read_repo",
  "list_tasks",
  "luca_memory_schema",
  "luca_calendar_list",
  // Notion reads
  "luca_notion_fetch",
  "luca_notion_search",
]);

/**
 * Shell commands (first word of `sandbox_shell` command string) that count
 * as read/observe operations rather than write/mutate operations.
 */
export const SHELL_OBSERVED_COMMANDS: Set<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "df",
  "du",
  "ps",
  "pwd",
  "env",
  "git log",
  "git status",
  "git diff",
  "git show",
]);

/**
 * Returns true if the tool invocation counts as an "observed" data source
 * for provenance purposes.
 *
 * - For most tools: checks TOOL_OBSERVED_WHITELIST by exact name.
 * - For `sandbox_shell`: checks the first word of `toolArgs.command`
 *   (or two-word "git <subcommand>") against SHELL_OBSERVED_COMMANDS.
 */
export function isObservedTool(
  toolName: string,
  toolArgs?: Record<string, unknown>,
): boolean {
  if (toolName !== "sandbox_shell") {
    return TOOL_OBSERVED_WHITELIST.has(toolName);
  }

  // sandbox_shell: inspect the command string.
  const command = typeof toolArgs?.command === "string" ? toolArgs.command.trim() : "";
  if (!command) return false;

  const parts = command.split(/\s+/);
  const firstWord = parts[0] ?? "";
  // Check two-word "git <subcommand>" first (e.g. "git log").
  if (firstWord === "git" && parts.length >= 2) {
    const twoWord = `git ${parts[1]}`;
    if (SHELL_OBSERVED_COMMANDS.has(twoWord)) return true;
  }
  return SHELL_OBSERVED_COMMANDS.has(firstWord);
}

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
  "web_search",
  "read_url",
  "read_file",
  "read_cloud_file",
  "search_cloud_files",
  "gmail_read",
  "gmail_search",
  "search_emails",
  "read_email_thread",
  "inbox_read",
  "inbox_list",
  "analyze_image",
  "listen_audio",
  "watch_video",
  "luca_read_repo",
  "sandbox_read_file",
  "sandbox_list_files",
  "workspace_read",
  "workspace_list",
  "list_tasks",
  "gmail_accounts_status",
  "luca_memory_schema",
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

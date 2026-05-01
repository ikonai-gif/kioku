/**
 * Luca V1a tool registry.
 *
 * Single source of truth for the set of tools offered to Luca. Each tool
 * is flag-gated at THREE levels (master → tools-master → per-tool) so we
 * can ship tool code dark and flip flags one-by-one in prod without
 * redeploying.
 *
 * This is NOT wired into partner-chat `loadPartnerToolsForAgent()` —
 * partner-chat has its own tool set. Luca's turn-runner (Day 6) will call
 * `getLucaTools()` directly. Until Day 6 lands, this registry is dormant
 * but the tool handlers are unit-testable in isolation.
 *
 * Adding a new tool (checklist):
 *   1. Add `LUCA_TOOL_<NAME>_ENABLED` to env.ts LucaEnv interface + readLucaEnv()
 *   2. Add the tool-flag literal to isLucaToolEnabled() type param union
 *   3. Implement handler in server/lib/luca-tools/<name>.ts
 *   4. Export Anthropic tool spec + add to `ALL_LUCA_TOOLS` below
 *   5. Add handler dispatch case in `dispatchLucaTool()` below
 *   6. Write unit tests + a golden-set test asserting the tool is only
 *      listed when all three flags are on
 */
import type Anthropic from "@anthropic-ai/sdk";
import { isLucaToolEnabled } from "../luca/env";
import { runCodeTool, runCodeHandler, type RunCodeContext } from "./run-code";
import {
  analyzeImageTool,
  analyzeImageHandler,
  type AnalyzeImageContext,
} from "./analyze-image";
import {
  searchTool,
  searchHandler,
  type SearchContext,
} from "./search";
import {
  readUrlTool,
  readUrlHandler,
  type ReadUrlContext,
} from "./read-url";
import {
  agentBrowserTool,
  agentBrowserHandler,
  buildAgentBrowserTool,
  type AgentBrowserContext,
} from "./agent-browser";
import {
  inboxListTool,
  inboxListHandler,
  emailReadTool,
  emailReadHandler,
  emailThreadTool,
  emailThreadHandler,
  type EmailReadContext,
} from "./email-read";
import { isLucaEmailToolEnabled } from "../luca/env";

// ─── Registry ────────────────────────────────────────────────────────────

/**
 * Map from tool name → (Anthropic spec, required per-tool flag).
 * Day 2 ships only `run_code`. Day 3-5 add analyze_image, web_search,
 * read_url, memory, file tools.
 */
/**
 * Kind of gate the registry uses to decide if a tool is live.
 *   - "tool": three-level check via isLucaToolEnabled (master + tools-master + per-tool)
 *   - "email": four-level check via isLucaEmailToolEnabled (adds LUCA_EMAIL_SCOPE_ENABLED)
 *
 * Keeps the entry list declarative — adding a new scope in the future
 * (Drive, GitHub, etc.) means one more kind + one more line per tool, not
 * a branch in getLucaTools().
 */
type LucaToolEntry =
  | {
      kind: "tool";
      spec: Anthropic.Messages.Tool;
      flag: Parameters<typeof isLucaToolEnabled>[0];
    }
  | {
      kind: "email";
      spec: Anthropic.Messages.Tool;
      flag: Parameters<typeof isLucaEmailToolEnabled>[0];
    };

const LUCA_TOOL_ENTRIES: ReadonlyArray<LucaToolEntry> = [
  { kind: "tool", spec: runCodeTool, flag: "LUCA_TOOL_RUN_CODE_ENABLED" },
  { kind: "tool", spec: analyzeImageTool, flag: "LUCA_TOOL_ANALYZE_IMAGE_ENABLED" },
  { kind: "tool", spec: searchTool, flag: "LUCA_TOOL_SEARCH_ENABLED" },
  { kind: "tool", spec: readUrlTool, flag: "LUCA_TOOL_READ_URL_ENABLED" },
  // R343 — Stagehand-driven multi-step browser. Three-level flag stack PLUS
  // global LUCA_BROWSER_DISABLED kill-switch PLUS empty-allowlist short-circuit
  // (see server/lib/luca-tools/agent-browser.ts module doc).
  { kind: "tool", spec: agentBrowserTool, flag: "LUCA_TOOL_AGENT_BROWSER_ENABLED" },
  // Step 4 PR A — Gmail read tools (extra scope master)
  { kind: "email", spec: inboxListTool, flag: "LUCA_TOOL_EMAIL_READ_ENABLED" },
  { kind: "email", spec: emailReadTool, flag: "LUCA_TOOL_EMAIL_READ_ENABLED" },
  { kind: "email", spec: emailThreadTool, flag: "LUCA_TOOL_EMAIL_READ_ENABLED" },
  // Day 5+: read_memory, write_memory, read_file, upload_file
];

function isEntryLive(entry: LucaToolEntry): boolean {
  if (entry.kind === "tool") return isLucaToolEnabled(entry.flag);
  return isLucaEmailToolEnabled(entry.flag);
}

/**
 * Build the Anthropic tool list offered to Luca's LLM call.
 *
 * Returns only the tools whose per-tool flag is on AND master flags are on.
 * If ANY flag is off for a given tool, that tool is silently omitted — the
 * LLM never sees it, so it can't attempt a disabled tool call.
 *
 * Defensive second layer: even if a tool SOMEHOW gets called (forged
 * tool_use block, test harness, future bug), the handler also checks its
 * own flag and returns `{status: "disabled"}` without side-effects.
 */
export function getLucaTools(): Anthropic.Messages.Tool[] {
  return LUCA_TOOL_ENTRIES.filter(isEntryLive).map((e) =>
    // agent_browser embeds the live allowlist in its description — rebuild
    // every call so the LLM sees fresh env values without process restart.
    e.spec.name === "luca_agent_browser" ? buildAgentBrowserTool() : e.spec,
  );
}

// ─── Dispatch ────────────────────────────────────────────────────────────

/**
 * Dispatch an incoming `tool_use` block to its handler. Called by Luca's
 * turn-runner after the LLM returns a tool_use. Maps to
 * `tool_result.content`.
 *
 * Throws `Error("luca_tool_not_found: <name>")` if the tool isn't in the
 * registry. Turn-runner maps to `is_error: true` tool_result so the LLM
 * can recover.
 */
export async function dispatchLucaTool(
  toolName: string,
  toolInput: unknown,
  ctx: RunCodeContext &
    AnalyzeImageContext &
    SearchContext &
    ReadUrlContext &
    AgentBrowserContext &
    EmailReadContext,
): Promise<unknown> {
  switch (toolName) {
    case "luca_run_code":
      return runCodeHandler(toolInput, ctx);
    case "luca_analyze_image":
      return analyzeImageHandler(toolInput, ctx);
    case "luca_search":
      return searchHandler(toolInput, ctx);
    case "luca_read_url":
      return readUrlHandler(toolInput, ctx);
    case "luca_agent_browser":
      return agentBrowserHandler(toolInput, ctx);
    // Step 4 PR A — Luca-native Gmail reads
    case "luca_inbox_list":
      return inboxListHandler(toolInput, ctx);
    case "luca_email_read":
      return emailReadHandler(toolInput, ctx);
    case "luca_email_thread":
      return emailThreadHandler(toolInput, ctx);
    // Day 5+: memory, files
    default:
      throw new Error(`luca_tool_not_found: ${toolName}`);
  }
}

// ─── Test helpers ────────────────────────────────────────────────────────

/**
 * Mock-only: enumerate the full tool list regardless of flags. For unit
 * tests that want to assert the registry shape without fiddling env vars.
 */
export function __getAllLucaToolSpecsForTests(): Anthropic.Messages.Tool[] {
  return LUCA_TOOL_ENTRIES.map((e) => e.spec);
}

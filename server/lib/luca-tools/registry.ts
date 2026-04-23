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

// ─── Registry ────────────────────────────────────────────────────────────

/**
 * Map from tool name → (Anthropic spec, required per-tool flag).
 * Day 2 ships only `run_code`. Day 3-5 add analyze_image, web_search,
 * read_url, memory, file tools.
 */
interface LucaToolEntry {
  spec: Anthropic.Messages.Tool;
  flag: Parameters<typeof isLucaToolEnabled>[0];
}

const LUCA_TOOL_ENTRIES: ReadonlyArray<LucaToolEntry> = [
  { spec: runCodeTool, flag: "LUCA_TOOL_RUN_CODE_ENABLED" },
  { spec: analyzeImageTool, flag: "LUCA_TOOL_ANALYZE_IMAGE_ENABLED" },
  // Day 4: { spec: searchTool, flag: "LUCA_TOOL_SEARCH_ENABLED" },
  // Day 5: read_memory, write_memory, read_file, upload_file
];

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
  return LUCA_TOOL_ENTRIES
    .filter((e) => isLucaToolEnabled(e.flag))
    .map((e) => e.spec);
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
  ctx: RunCodeContext & AnalyzeImageContext,
): Promise<unknown> {
  switch (toolName) {
    case "luca_run_code":
      return runCodeHandler(toolInput, ctx);
    case "luca_analyze_image":
      return analyzeImageHandler(toolInput, ctx);
    // Day 4-5: web_search, read_url, memory, files
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

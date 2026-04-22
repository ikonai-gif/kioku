/**
 * meeting-tools — tool-scope restriction for Meeting Room turns (W9 Item 2 M2).
 *
 * Invariant: meeting turns NEVER write to personal memory. The artifact /
 * end-meeting consolidation path (Item 5) is the only legitimate way for
 * meeting content to reach `memories`, and only when the participant
 * profile has `carry_over_memory=true`, under the reserved
 * `_meeting_summary_{meetingId}` namespace.
 *
 * To enforce this in code (not by convention), the turn runner builds its
 * LLM tool set via `getMeetingTurnTools(agent)` which filters ANY tool whose
 * name is in `MEMORY_WRITE_TOOLS` out of the full registry.
 *
 * A golden-set guard test (`meeting-tools-golden.test.ts`) runs the tool
 * registry through a regex that matches likely memory-write tool names
 * (`remember`, `updateMemory`, `deleteMemory`, `saveMemory`, `storeMemory`,
 * anything ending in `Memory`) and fails if any such tool is NOT in
 * `MEMORY_WRITE_TOOLS`. This guards against W10+ drift where someone adds
 * a new memory-write tool without updating the set.
 */
import type Anthropic from "@anthropic-ai/sdk";

/**
 * The canonical list of memory-write tool names excluded from meeting turns.
 *
 * When a new memory-write tool lands in the partner registry, add its name
 * here AND confirm `meeting-tools-golden.test.ts` still passes. The golden
 * test is the tripwire; this set is the policy.
 */
export const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "remember",
  "updateMemory",
  "deleteMemory",
  "correct_false_memory", // snake_case delete-by-id from partner registry (W7 P2.14)
  "saveMemory",     // reserved for future — not in registry today
  "storeMemory",    // reserved for future — not in registry today
]);

/**
 * Regex matching names that LOOK like memory-write tools. Used by the golden
 * guard test: any tool whose name matches this MUST be in MEMORY_WRITE_TOOLS
 * or the test fails — forcing a deliberate decision about whether the new
 * tool belongs in a meeting turn's tool set.
 */
export const MEMORY_WRITE_TOOL_NAME_REGEX =
  /^(remember|updateMemory|deleteMemory|storeMemory|saveMemory|writeMemory|correct_false_memory|.*[Mm]emory)$/;

/**
 * Filter a full tool list down to the subset safe for in-meeting use.
 *
 * Current policy (W9 MVP): exclude memory-write tools. Future (Item 5 or
 * W10): may also scope tools by `participation_mode` (observe → read-only
 * subset, autonomous → full set minus memory writes).
 */
export function getMeetingTurnTools(
  allTools: Anthropic.Messages.Tool[],
): Anthropic.Messages.Tool[] {
  return allTools.filter((t) => !MEMORY_WRITE_TOOLS.has(t.name));
}

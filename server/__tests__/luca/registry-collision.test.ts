/**
 * Luca V1a Day 2 — registry collision guard (Bro2 Day 2 M2).
 *
 * Luca's tool registry (`luca-tools/registry.ts`) and partner-chat's
 * deliberation registry (`server/deliberation.ts`) are both Anthropic tool
 * lists. They're loaded in DIFFERENT code paths today — Luca's turn-runner
 * (Day 6) vs partner-chat's `loadPartnerToolsForAgent`. If a future refactor
 * ever accidentally merges them into one `tools:` array for a single LLM
 * call, any name collision blows up:
 *
 *   - Anthropic SDK may reject duplicate tool names outright.
 *   - OR silently last-write-wins → Luca's handler invoked with partner-chat
 *     input_schema (language/packages/output_files) which
 *     `parseRunCodeInput` will throw on.
 *   - Forensic `tool_runs` queries become collision-prone if both registries
 *     ever share a backend.
 *
 * This tripwire test catches name overlap at CI time. Rule:
 *
 *   Every Luca tool name MUST NOT appear in the partner-chat registry.
 *
 * Fix when failing:
 *   1. Rename the Luca tool (`luca_<n>`).
 *   2. Update all references (runCodeTool.name, dispatchLucaTool switch,
 *      tests, tool_runs `tool` column writes).
 */
import { describe, it, expect } from "vitest";
import { __getAllLucaToolSpecsForTests } from "../../lib/luca-tools/registry";
import { getPartnerToolsForAgent } from "../../deliberation";

describe("Luca vs partner-chat tool name collision (Bro2 Day 2 M2)", () => {
  it("no Luca tool name appears in partner-chat registry", () => {
    const lucaTools = __getAllLucaToolSpecsForTests();
    const lucaNames = new Set(lucaTools.map((t) => t.name));

    // Check both Luca-scoped and non-Luca-scoped partner tool lists, since
    // the partner registry varies by agent name.
    const partnerLuca = getPartnerToolsForAgent({ name: "Luca" });
    const partnerOther = getPartnerToolsForAgent({ name: "__non_luca_agent__" });
    const partnerNames = new Set([
      ...partnerLuca.map((t) => t.name),
      ...partnerOther.map((t) => t.name),
    ]);

    const collisions = [...lucaNames].filter((n) => partnerNames.has(n));
    expect(
      collisions,
      `Tool name(s) ${JSON.stringify(collisions)} exist in BOTH Luca's and ` +
        `partner-chat's tool registry. Rename the Luca tool (prefix with ` +
        `\`luca_\`) to prevent Anthropic SDK duplicate-name failure if the ` +
        `two lists ever get merged. See run-code.ts header for rationale.`,
    ).toEqual([]);
  });

  it("Luca's run_code is named `luca_run_code` (not `run_code`)", () => {
    // Explicit regression guard. If someone "simplifies" the name back to
    // `run_code`, this test fails before the collision test.
    const lucaTools = __getAllLucaToolSpecsForTests();
    const names = lucaTools.map((t) => t.name);
    expect(names).toContain("luca_run_code");
    expect(names).not.toContain("run_code");
  });
});

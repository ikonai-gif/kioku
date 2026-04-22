/**
 * Golden-set guard (Bro2 F1, W9 Item 2): the MEMORY_WRITE_TOOLS constant in
 * meeting-tools.ts is the POLICY for which tools are kept out of meeting turns.
 * This test is the TRIPWIRE: if someone adds a new memory-write tool to the
 * partner registry in W10+ without updating MEMORY_WRITE_TOOLS, this test
 * fails and forces a deliberate decision about whether the new tool belongs
 * in a meeting turn's tool set.
 *
 * What it checks:
 *   1. getMeetingTurnTools strips every name in MEMORY_WRITE_TOOLS from a
 *      synthetic input (regardless of what the real registry contains).
 *   2. Every tool in the CURRENT partner registry whose name matches
 *      MEMORY_WRITE_TOOL_NAME_REGEX is in MEMORY_WRITE_TOOLS. This is the
 *      dedicated Bro2 F1 guard — the regex is wider than the set, so any
 *      drift fires here.
 */
import { describe, it, expect } from "vitest";
import { MEMORY_WRITE_TOOLS, MEMORY_WRITE_TOOL_NAME_REGEX, getMeetingTurnTools } from "../lib/meeting-tools";
import { getPartnerToolsForAgent } from "../deliberation";

describe("meeting-tools golden set (Bro2 F1)", () => {
  it("strips memory-write tool names from an arbitrary input", () => {
    // Synthetic tool list with representative names + one Luca studio tool
    // so we prove the filter is a deny-list, not an allow-list.
    const input = [
      { name: "remember", input_schema: { type: "object", properties: {} }, description: "" },
      { name: "updateMemory", input_schema: { type: "object", properties: {} }, description: "" },
      { name: "deleteMemory", input_schema: { type: "object", properties: {} }, description: "" },
      { name: "workspace_list", input_schema: { type: "object", properties: {} }, description: "" },
      { name: "workspace_read",  input_schema: { type: "object", properties: {} }, description: "" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const filtered = getMeetingTurnTools(input);
    const names = filtered.map((t) => t.name);
    expect(names).not.toContain("remember");
    expect(names).not.toContain("updateMemory");
    expect(names).not.toContain("deleteMemory");
    expect(names).toContain("workspace_list");
    expect(names).toContain("workspace_read");
  });

  it("every partner-registry tool whose name matches the memory-write regex is in MEMORY_WRITE_TOOLS", () => {
    // Luca-scoped tool list is a superset of what meeting turns use because
    // Luca is the representative meeting participant. Test both to catch drift
    // introduced by agents with broader registries.
    const lucaTools = getPartnerToolsForAgent({ name: "Luca" });
    const fullTools = getPartnerToolsForAgent({ name: "__non_luca_agent__" });
    const allTools = [...lucaTools, ...fullTools];
    const matched = allTools.filter((t) => MEMORY_WRITE_TOOL_NAME_REGEX.test(t.name));

    // Deduplicate by name since Luca + full lists overlap.
    const matchedNames = Array.from(new Set(matched.map((t) => t.name)));
    for (const name of matchedNames) {
      expect(
        MEMORY_WRITE_TOOLS.has(name),
        `Tool "${name}" looks like a memory-write tool (matches MEMORY_WRITE_TOOL_NAME_REGEX) but is NOT in MEMORY_WRITE_TOOLS. Either add it to the set in meeting-tools.ts OR explain in the test why it belongs inside meeting turns.`,
      ).toBe(true);
    }
  });

  it("getMeetingTurnTools on the real partner registry excludes every name in MEMORY_WRITE_TOOLS", () => {
    const lucaTools = getPartnerToolsForAgent({ name: "Luca" });
    const meetingTools = getMeetingTurnTools(lucaTools);
    for (const name of MEMORY_WRITE_TOOLS) {
      expect(
        meetingTools.find((t) => t.name === name),
        `Tool "${name}" leaked into getMeetingTurnTools output — the filter is broken.`,
      ).toBeUndefined();
    }
  });
});

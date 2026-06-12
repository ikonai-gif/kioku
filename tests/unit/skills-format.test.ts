/**
 * [LUCA-089 Part 3] Skills PR2 -- agentskills.io format helpers, unit tests.
 */
import { describe, it, expect } from "vitest";
import { toAgentSkillExport, parseAgentSkillImport } from "../../server/lib/skills-format";

describe("toAgentSkillExport", () => {
  it("maps a DB row to the agentskills.io shape with kioku_extension", () => {
    const out = toAgentSkillExport({
      id: 42,
      name: "auto_generate_image",
      category: "auto",
      description: "d",
      prompt_template: "p",
      trigger_pattern: "image of",
      tool_sequence: JSON.stringify(["generate_image"]),
      auto_created: true,
      use_count: 7,
      created_at: new Date("2026-06-12T06:00:00Z"),
    });
    expect(out.skill_id).toBe("kioku-42");
    expect(out.version).toBe("1.0.0");
    expect(out.author).toBe("kioku");
    expect(out.trigger_patterns).toEqual(["image of"]);
    expect(out.tool_requirements).toEqual(["generate_image"]);
    expect(out.created_at).toBe("2026-06-12T06:00:00.000Z");
    expect(out.kioku_extension).toEqual({ auto_created: true, tool_sequence: ["generate_image"], use_count: 7 });
  });

  it("tolerates null trigger, junk tool_sequence and missing dates", () => {
    const out = toAgentSkillExport({
      id: "1",
      name: "ask_the_council",
      category: "meta",
      description: "",
      prompt_template: "x",
      trigger_pattern: null,
      tool_sequence: "not json",
      auto_created: false,
      created_at: null,
    });
    expect(out.trigger_patterns).toBeUndefined();
    expect(out.tool_requirements).toBeUndefined();
    expect(out.kioku_extension?.tool_sequence).toEqual([]);
    expect(out.kioku_extension?.use_count).toBe(0);
  });
});

describe("parseAgentSkillImport", () => {
  const good = {
    name: "summarize_inbox",
    category: "email",
    description: "d",
    prompt_template: "do it",
    trigger_patterns: ["inbox summary"],
    kioku_extension: { tool_sequence: ["email_triage", "list_tasks"], auto_created: false, use_count: 0 },
  };

  it("accepts a valid agentskills.io object", () => {
    const r = parseAgentSkillImport(good);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("summarize_inbox");
      expect(r.value.trigger_pattern).toBe("inbox summary");
      expect(r.value.tool_sequence).toBe(JSON.stringify(["email_triage", "list_tasks"]));
    }
  });

  it("falls back to tool_requirements when kioku_extension is absent", () => {
    const r = parseAgentSkillImport({ ...good, kioku_extension: undefined, tool_requirements: ["x"] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tool_sequence).toBe(JSON.stringify(["x"]));
  });

  it("rejects junk", () => {
    expect(parseAgentSkillImport(null).ok).toBe(false);
    expect(parseAgentSkillImport({}).ok).toBe(false);
    expect(parseAgentSkillImport({ name: "x".repeat(65), prompt_template: "p" }).ok).toBe(false);
    expect(parseAgentSkillImport({ name: "ok", category: "c".repeat(33), prompt_template: "p" }).ok).toBe(false);
    expect(parseAgentSkillImport({ name: "ok" }).ok).toBe(false);
  });

  it("defaults category to imported", () => {
    const r = parseAgentSkillImport({ name: "n", prompt_template: "p" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.category).toBe("imported");
  });
});

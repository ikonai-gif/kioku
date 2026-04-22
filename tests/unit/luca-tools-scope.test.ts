import { describe, it, expect } from "vitest";
import { getPartnerToolsForAgent, LUCA_STUDIO_TOOL_NAMES, buildPartnerPrompt } from "../../server/deliberation.js";

describe("getPartnerToolsForAgent — Luca Studio scope (W7 P2.5)", () => {
  it("returns exactly 19 tools for Luca (15 media + 3 workspace + 1 self-accountability)", () => {
    // P2.6: bumped from 16 to 18 — added reframe_vertical + apply_ai_disclosure
    //       because produce_episode plan names them by hand (Bro2 F1).
    // P2.12: bumped from 18 to 19 — added `remember` for Luca self-write memory
    //        (self-accountability MVP). Scoped to (userId, agentId) on write.
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    expect(tools).toHaveLength(19);
  });

  it("includes the produce_episode pipeline dependencies (P2.6 Bro2 F1)", () => {
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    const names = new Set(tools.map(t => t.name));
    // These two are named by hand in produce_episode plan (deliberation.ts:4661, 4667).
    expect(names.has("reframe_vertical")).toBe(true);
    expect(names.has("apply_ai_disclosure")).toBe(true);
  });

  it("returns only tools in LUCA_STUDIO_TOOL_NAMES for Luca", () => {
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    for (const t of tools) {
      expect(LUCA_STUDIO_TOOL_NAMES.has(t.name)).toBe(true);
    }
  });

  it("returns the full registry for unknown / non-Luca partner agents", () => {
    const luca = getPartnerToolsForAgent({ name: "Luca" });
    const other = getPartnerToolsForAgent({ name: "SomeOther" });
    const nullAgent = getPartnerToolsForAgent(null);
    expect(other.length).toBeGreaterThan(luca.length);
    expect(nullAgent.length).toBe(other.length);
    expect(other.length).toBeGreaterThanOrEqual(40); // registry has 60+ tools
  });

  it("does NOT expose Gmail, web_search, stripe, github, or other non-studio tools to Luca", () => {
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    const names = new Set(tools.map(t => t.name));
    // P2.6: reframe_vertical + apply_ai_disclosure removed from forbidden list
    // (they are now in-scope for produce_episode pipeline).
    const forbidden = [
      "gmail_search", "gmail_read", "send_email_reply", "send_new_email",
      "web_search", "read_url",
      "stripe_list", "github_call", "vercel_call", "supabase_query",
      "google_sheets", "google_drive", "gcal",
      "creative_writing", "run_code", "composio_action",
      "build_project", "analyze_image", "browse_website",
      "plan_steps", "delegate_task", "produce_season",
      "read_own_prompt", "suggest_self_improvement",
    ];
    for (const f of forbidden) {
      expect(names.has(f)).toBe(false);
    }
  });

  it("LUCA_STUDIO_TOOL_NAMES stays in sync with what buildPartnerPrompt advertises", () => {
    // If prompt lists a tool, the schema must expose it; if schema exposes it, prompt must list it.
    const prompt = buildPartnerPrompt("Luca", "", "## WHO YOU ARE\nYou are Luca.\n");
    for (const toolName of LUCA_STUDIO_TOOL_NAMES) {
      expect(prompt).toContain(toolName);
    }
  });

  it("all 19 Luca tools have valid Anthropic Tool shape (name + input_schema)", () => {
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.input_schema).toBeDefined();
      expect((t.input_schema as any).type).toBe("object");
    }
  });
});

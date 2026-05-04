import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPartnerToolsForAgent, LUCA_STUDIO_TOOL_NAMES, getLucaStudioToolNames, buildPartnerPrompt } from "../../server/deliberation.js";

// Day 6 part 3: most tests assume expanded scope is OFF (base 19 tools).
// A dedicated `describe` block at the end flips the flag and asserts the
// expanded surface. Restoring env in afterEach keeps tests independent.
const FLAG = "LUCA_EXPANDED_SCOPE_ENABLED";

describe("getPartnerToolsForAgent — Luca Studio scope (W7 P2.5)", () => {
  const originalFlag = process.env[FLAG];
  beforeEach(() => {
    // Base surface — flag off.
    delete process.env[FLAG];
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });
  it("returns exactly 24 tools for Luca (15 media + 3 workspace + 1 remember + 1 luca_memory_schema + 2 multimodal + 1 telegram + 1 browse_website)", () => {
    // P2.6: bumped from 16 to 18 — added reframe_vertical + apply_ai_disclosure
    //       because produce_episode plan names them by hand (Bro2 F1).
    // P2.12: bumped from 18 to 19 — added `remember` for Luca self-write memory
    //        (self-accountability MVP). Scoped to (userId, agentId) on write.
    // Day 6 part 3: base surface only; expanded scope requires the flag.
    // Multimodal extension: bumped from 19 to 21 — added watch_video +
    //        listen_audio (READ_ONLY, SSRF-fenced via validateUrl).
    // LEO PR-A: bumped from 21 to 22 — added send_telegram_message
    //        (HIGH_STAKES_WRITE; tiered downgrade in classifyToolCall).
    // R-strategic uplift: bumped from 22 to 23 — added browse_website
    //        (Puppeteer in E2B sandbox; READ_ONLY).
    // R455: bumped from 23 to 24 — added luca_memory_schema (READ_ONLY,
    //        self-introspection of Luca's own memory architecture).
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    expect(tools).toHaveLength(24);
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

  it("getLucaStudioToolNames() === base LUCA_STUDIO_TOOL_NAMES when flag off", () => {
    // Sanity: the runtime-effective scope equals the base constant when the
    // expanded flag is off. If a future refactor breaks this, tests that
    // pin counts (19) still pass but drift may creep in — assert it.
    const effective = getLucaStudioToolNames();
    expect(effective.size).toBe(LUCA_STUDIO_TOOL_NAMES.size);
    for (const t of LUCA_STUDIO_TOOL_NAMES) expect(effective.has(t)).toBe(true);
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
      "build_project", "analyze_image",
      // browse_website now ADMITTED to base scope (R-strategic uplift).
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

  it("all 24 Luca tools have valid Anthropic Tool shape (name + input_schema)", () => {
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.input_schema).toBeDefined();
      expect((t.input_schema as any).type).toBe("object");
    }
  });
});

// Day 6 part 3 — expanded scope behind LUCA_EXPANDED_SCOPE_ENABLED flag.
// The base surface tests above run with flag OFF; these flip it on and
// verify the additional 18 Gmail / cloud / schedule / producer tools
// become admissible, schemas are exposed, and the forbidden list shrinks.
describe("getPartnerToolsForAgent — expanded scope (Day 6 part 3)", () => {
  const originalFlag = process.env[FLAG];
  beforeEach(() => {
    process.env[FLAG] = "true";
  });
  afterEach(() => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  it("returns base 24 + expanded 18 = 42 tools for Luca when flag is on", () => {
    const tools = getPartnerToolsForAgent({ name: "Luca" });
    // 15 media + 3 workspace + 1 remember + 1 luca_memory_schema (R455) +
    // 2 multimodal (watch_video, listen_audio) + 1 send_telegram_message
    // (LEO PR-A) + 1 browse_website (R-strategic uplift) + 10 Gmail
    // reads/triage + 2 sends + 2 cloud reads + 3 scheduling +
    // 1 produce_season = 42.
    expect(tools).toHaveLength(42);
  });

  it("includes Gmail, cloud, scheduling, producer tools in expanded scope", () => {
    const names = new Set(getPartnerToolsForAgent({ name: "Luca" }).map(t => t.name));
    for (const n of [
      "gmail_search", "gmail_read", "gmail_accounts_status", "gmail_reconnect_link",
      "inbox_list", "inbox_read", "inbox_action", "read_email_thread",
      "search_emails", "email_triage",
      "send_email_reply", "send_new_email",
      "search_cloud_files", "read_cloud_file",
      "schedule_task", "set_reminder", "list_tasks",
      "produce_season",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("still blocks composio_action, build_project, and other out-of-scope tools", () => {
    const names = new Set(getPartnerToolsForAgent({ name: "Luca" }).map(t => t.name));
    for (const n of [
      "composio_action", "build_project", "plan_steps", "delegate_task",
      "web_search", "read_url", "run_code", "analyze_image",
      "creative_writing",
      // browse_website now ADMITTED — R-strategic uplift, see classify.ts
    ]) {
      expect(names.has(n)).toBe(false);
    }
  });

  it("getLucaStudioToolNames() returns a fresh Set reflecting current flag", () => {
    // Base 24 (19 original + watch_video + listen_audio multimodal reads
    // + send_telegram_message LEO PR-A + browse_website R-strategic uplift
    // + luca_memory_schema R455 self-introspection).
    // Expanded adds 18 (gmail/cloud/schedule/produce_season).
    const withFlag = getLucaStudioToolNames();
    expect(withFlag.size).toBe(42);
    delete process.env[FLAG];
    const withoutFlag = getLucaStudioToolNames();
    expect(withoutFlag.size).toBe(24);
  });
});

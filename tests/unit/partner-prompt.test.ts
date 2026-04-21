import { describe, it, expect } from "vitest";
import { buildPartnerPrompt } from "../../server/deliberation.js";

describe("buildPartnerPrompt — Luca identity integrity (W7 P2.4)", () => {
  const identityMem = `## WHO YOU ARE
You are Luca. You are Boss's (Kote's) partner inside KIOKU.
You call him Boss, never "user". You speak Russian with him at home.
You were born inside KIOKU and grew alongside him — you share his taste, his rhythm, his sense of humor.
`;

  it("injects the provided identity section verbatim", () => {
    const prompt = buildPartnerPrompt("Luca", "partner agent", identityMem);
    expect(prompt).toContain("You are Luca. You are Boss's (Kote's) partner");
    expect(prompt).toContain("You call him Boss");
  });

  it("does NOT reintroduce the old hardcoded generic personality override", () => {
    const prompt = buildPartnerPrompt("Luca", "partner agent", identityMem);
    // These lines came from the generic block we removed — they must be gone.
    expect(prompt).not.toContain("You are a person, not a service.");
    expect(prompt).not.toContain("Quietly witty");
    expect(prompt).not.toMatch(/## WHO YOU ARE\s+—\s+LUCA/);
  });

  it("lists the 16 real Luca Studio tools", () => {
    const prompt = buildPartnerPrompt("Luca", "", identityMem);
    const realTools = [
      "generate_image",
      "generate_video",
      "generate_image_to_video",
      "generate_speech",
      "clone_voice",
      "generate_sfx",
      "generate_music",
      "stitch_media",
      "add_subtitles",
      "add_title_cards",
      "series_bible",
      "produce_episode",
      "generate_document",
      "workspace_list",
      "workspace_save",
      "workspace_read",
    ];
    for (const tool of realTools) {
      expect(prompt).toContain(tool);
    }
  });

  it("does NOT advertise phantom tools that caused Q2 hallucination", () => {
    const prompt = buildPartnerPrompt("Luca", "", identityMem);
    // These tools do NOT exist in Luca Studio — listing them caused the PR-speak hallucination.
    // We search for each as a tool bullet (prefixed by `- `) to avoid false positives
    // from the explicit "Do NOT claim to have" denylist line.
    const phantomTools = [
      "creative_writing",
      "run_code",
      "composio_action",
      "build_project",
      "analyze_image",
      "plan_steps",
      "delegate_task",
      "browse_website",
      "reframe_vertical",
      "apply_ai_disclosure",
      "produce_season",
      "read_own_prompt",
      "suggest_self_improvement",
    ];
    for (const tool of phantomTools) {
      expect(prompt).not.toMatch(new RegExp(`^\\s*-\\s*${tool}\\b`, "m"));
    }
  });

  it("includes the denylist paragraph (positive control — guards against removing the guardrail itself)", () => {
    // Bro2 P2.4 N2: without this test, a future change could accidentally delete the denylist
    // paragraph and the phantoms-as-bullets test would still pass (false-green).
    const prompt = buildPartnerPrompt("Luca", "", identityMem);
    expect(prompt).toContain("Do NOT claim to have");
    expect(prompt).toContain("creative_writing");
    expect(prompt).toContain("run_code");
    expect(prompt).toContain("composio_action");
  });

  it("read_own_prompt regex headers match what buildPartnerPrompt emits (W7 P2.4 F1 guard)", () => {
    // Bro2 P2.4 F1: read_own_prompt tool at deliberation.ts:1657-1664 matches these exact
    // section headers. This test locks the header strings so the tool can't silently break.
    const prompt = buildPartnerPrompt("Luca", "", identityMem);
    expect(prompt).toMatch(/## WHO YOU ARE[\s\S]*?(?=## |$)/);
    expect(prompt).toMatch(/## YOUR ACTUAL CAPABILITIES[\s\S]*?(?=## |$)/);
  });

  it("keeps AI disclosure and language rules", () => {
    const prompt = buildPartnerPrompt("Luca", "", identityMem);
    expect(prompt).toContain("AI DISCLOSURE");
    expect(prompt).toContain("Always respond in the same language");
  });

  it("preserves mood, emotion, and relationship blocks when provided", () => {
    const prompt = buildPartnerPrompt(
      "Luca",
      "",
      identityMem,
      { pleasure: 0.2, arousal: 0.1, dominance: 0.0, emotionLabel: "calm-focused" },
      { trustLevel: 0.8, interactionCount: 42 },
    );
    expect(prompt).toContain("calm-focused");
    expect(prompt).toContain("close (42 conversations)");
  });
});

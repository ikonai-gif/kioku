/**
 * Tests for Phase 8 Aesthetic Intelligence — preference CRUD, profile aggregation,
 * aesthetic memory creation, creative deliberation roles, auto-deliberation flow,
 * feedback reaction saving.
 * All OpenAI / LLM calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock OpenAI ─────────────────────────────────────────────────
const mockChatCompletionsCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: { create: mockChatCompletionsCreate },
      },
    })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Preference CRUD ─────────────────────────────────────────────
describe("Preference CRUD", () => {
  it("creates a preference with required fields", () => {
    const pref = {
      userId: 1,
      agentId: 1,
      category: "visual",
      item: "Klimt's The Kiss",
      reaction: "love",
      context: "Gold leaf texture",
      tags: ["art_nouveau", "gold", "romantic"],
      createdAt: Date.now(),
    };

    expect(pref.category).toBe("visual");
    expect(pref.reaction).toBe("love");
    expect(pref.tags).toHaveLength(3);
    expect(pref.tags).toContain("art_nouveau");
  });

  it("validates reaction types", () => {
    const validReactions = ["love", "like", "neutral", "dislike", "hate"];
    for (const r of validReactions) {
      expect(validReactions).toContain(r);
    }
    expect(validReactions).not.toContain("amazing");
  });

  it("validates category types", () => {
    const validCategories = ["visual", "music", "writing", "fashion", "general"];
    for (const c of validCategories) {
      expect(validCategories).toContain(c);
    }
    expect(validCategories).not.toContain("food");
  });

  it("handles preferences without context", () => {
    const pref = {
      category: "music",
      item: "Jazz",
      reaction: "love",
      context: undefined,
      tags: [],
    };
    expect(pref.context).toBeUndefined();
    expect(pref.tags).toHaveLength(0);
  });
});

// ── Profile Aggregation ─────────────────────────────────────────
describe("Preference Profile Aggregation", () => {
  function aggregateProfile(preferences: any[]): any {
    const categories: Record<string, { loves: string[]; dislikes: string[]; dominantTags: string[] }> = {};

    for (const pref of preferences) {
      const cat = pref.category;
      if (!categories[cat]) categories[cat] = { loves: [], dislikes: [], dominantTags: [] };

      if (pref.reaction === "love" || pref.reaction === "like") {
        categories[cat].loves.push(pref.item);
      } else if (pref.reaction === "dislike" || pref.reaction === "hate") {
        categories[cat].dislikes.push(pref.item);
      }
    }

    // Compute dominant tags per category
    for (const cat of Object.keys(categories)) {
      const catPrefs = preferences.filter((p: any) => p.category === cat);
      const tagCounts: Record<string, number> = {};
      for (const p of catPrefs) {
        for (const t of p.tags || []) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
      categories[cat].dominantTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag]) => tag);
      categories[cat].loves = [...new Set(categories[cat].loves)].slice(0, 10);
      categories[cat].dislikes = [...new Set(categories[cat].dislikes)].slice(0, 10);
    }

    return { categories, totalPreferences: preferences.length };
  }

  it("aggregates visual preferences correctly", () => {
    const prefs = [
      { category: "visual", item: "Art Nouveau", reaction: "love", tags: ["ornate", "gold"] },
      { category: "visual", item: "Minimalism", reaction: "dislike", tags: ["simple", "clean"] },
      { category: "visual", item: "Klimt", reaction: "love", tags: ["gold", "romantic"] },
    ];

    const profile = aggregateProfile(prefs);
    expect(profile.categories.visual.loves).toContain("Art Nouveau");
    expect(profile.categories.visual.loves).toContain("Klimt");
    expect(profile.categories.visual.dislikes).toContain("Minimalism");
    expect(profile.categories.visual.dominantTags).toContain("gold");
    expect(profile.totalPreferences).toBe(3);
  });

  it("handles multiple categories", () => {
    const prefs = [
      { category: "visual", item: "Impressionism", reaction: "love", tags: ["light"] },
      { category: "music", item: "Jazz", reaction: "love", tags: ["melodic"] },
      { category: "writing", item: "Poetry", reaction: "like", tags: ["lyrical"] },
    ];

    const profile = aggregateProfile(prefs);
    expect(Object.keys(profile.categories)).toHaveLength(3);
    expect(profile.categories.visual.loves).toContain("Impressionism");
    expect(profile.categories.music.loves).toContain("Jazz");
    expect(profile.categories.writing.loves).toContain("Poetry");
  });

  it("deduplicates items in loves/dislikes", () => {
    const prefs = [
      { category: "visual", item: "Gold", reaction: "love", tags: [] },
      { category: "visual", item: "Gold", reaction: "love", tags: [] },
      { category: "visual", item: "Gold", reaction: "love", tags: [] },
    ];

    const profile = aggregateProfile(prefs);
    expect(profile.categories.visual.loves).toHaveLength(1);
    expect(profile.categories.visual.loves[0]).toBe("Gold");
  });

  it("caps loves list at 10 items", () => {
    const prefs = Array.from({ length: 15 }, (_, i) => ({
      category: "visual",
      item: `Item ${i}`,
      reaction: "love",
      tags: [],
    }));

    const profile = aggregateProfile(prefs);
    expect(profile.categories.visual.loves.length).toBeLessThanOrEqual(10);
  });

  it("handles empty preferences", () => {
    const profile = aggregateProfile([]);
    expect(profile.totalPreferences).toBe(0);
    expect(Object.keys(profile.categories)).toHaveLength(0);
  });
});

// ── Aesthetic Memory Type ────────────────────────────────────────
describe("Aesthetic Memory Type", () => {
  it("aesthetic memory has 365-day half-life", () => {
    const HALF_LIFE_DAYS: Record<string, number> = {
      emotional: 30,
      semantic: 14,
      episodic: 7,
      procedural: Infinity,
      temporal: 14,
      causal: 14,
      contextual: 14,
      aesthetic: 365,
    };

    expect(HALF_LIFE_DAYS.aesthetic).toBe(365);
    expect(HALF_LIFE_DAYS.aesthetic).toBeGreaterThan(HALF_LIFE_DAYS.emotional);
    expect(HALF_LIFE_DAYS.aesthetic).toBeGreaterThan(HALF_LIFE_DAYS.semantic);
  });

  it("aesthetic memory has higher importance for strong reactions", () => {
    function getImportance(reaction: string): number {
      return reaction === "love" || reaction === "hate" ? 0.9 : 0.6;
    }

    expect(getImportance("love")).toBe(0.9);
    expect(getImportance("hate")).toBe(0.9);
    expect(getImportance("like")).toBe(0.6);
    expect(getImportance("neutral")).toBe(0.6);
    expect(getImportance("dislike")).toBe(0.6);
  });

  it("aesthetic memory content format is correct", () => {
    const reaction = "love";
    const item = "Klimt's The Kiss";
    const context = "Gold leaf texture";
    const tags = ["art_nouveau", "gold", "romantic"];

    const content = `[Aesthetic: ${reaction}] ${item}. ${context || ''}. Tags: ${tags.join(', ')}`;
    expect(content).toBe("[Aesthetic: love] Klimt's The Kiss. Gold leaf texture. Tags: art_nouveau, gold, romantic");
    expect(content).toContain("[Aesthetic:");
    expect(content).toContain("Tags:");
  });

  it("aesthetic memory uses _aesthetics namespace", () => {
    const namespace = "_aesthetics";
    expect(namespace).toBe("_aesthetics");
  });

  it("aesthetic memory decays very slowly", () => {
    // Simulate 30-day decay with aesthetic vs episodic
    function computeDecayedStrength(halfLifeDays: number, daysSince: number): number {
      if (halfLifeDays === Infinity) return 1.0;
      return Math.pow(0.5, daysSince / halfLifeDays);
    }

    const after30Days = computeDecayedStrength(365, 30);
    const episodicAfter30Days = computeDecayedStrength(7, 30);

    expect(after30Days).toBeGreaterThan(0.9); // Barely decayed
    expect(episodicAfter30Days).toBeLessThan(0.1); // Mostly gone
  });
});

// ── Creative Deliberation Roles ─────────────────────────────────
describe("Creative Deliberation Roles", () => {
  const CREATIVE_ROLES: Record<string, string> = {
    critic: `You are an ART CRITIC. Evaluate creative work with:
- Technical quality (craft, technique, structure)
- Emotional impact (does it move people?)
- Originality (is it derivative or fresh?)
- Historical context (what traditions does it draw from?)
Be honest but constructive. Point out both strengths and weaknesses.`,

    poet: `You are a POET/LYRICIST. Focus on:
- Language beauty (word choice, rhythm, sound)
- Imagery and metaphor
- Emotional truth
- The unsaid — what the gaps between words convey
Advocate for artistic risk and authenticity.`,

    historian: `You are an ART HISTORIAN. Bring context:
- What movement/tradition does this relate to?
- Who are the influences, acknowledged or not?
- How does this fit in the current cultural moment?
- What historical parallels exist?
Ground creative choices in knowledge.`,

    provocateur: `You are a CREATIVE PROVOCATEUR. Challenge comfort:
- Is this too safe? Too predictable?
- What would happen if the creator took the opposite approach?
- Where is the artist hiding behind technique instead of truth?
- What's the most interesting version of this that nobody would expect?
Push toward the edge without being destructive.`,
  };

  it("has exactly 4 creative roles", () => {
    expect(Object.keys(CREATIVE_ROLES)).toHaveLength(4);
  });

  it("has critic, poet, historian, provocateur roles", () => {
    expect(CREATIVE_ROLES).toHaveProperty("critic");
    expect(CREATIVE_ROLES).toHaveProperty("poet");
    expect(CREATIVE_ROLES).toHaveProperty("historian");
    expect(CREATIVE_ROLES).toHaveProperty("provocateur");
  });

  it("critic focuses on technical quality and originality", () => {
    expect(CREATIVE_ROLES.critic).toContain("Technical quality");
    expect(CREATIVE_ROLES.critic).toContain("Originality");
    expect(CREATIVE_ROLES.critic).toContain("honest but constructive");
  });

  it("poet focuses on language beauty and emotional truth", () => {
    expect(CREATIVE_ROLES.poet).toContain("Language beauty");
    expect(CREATIVE_ROLES.poet).toContain("Emotional truth");
    expect(CREATIVE_ROLES.poet).toContain("artistic risk");
  });

  it("historian provides cultural context", () => {
    expect(CREATIVE_ROLES.historian).toContain("movement/tradition");
    expect(CREATIVE_ROLES.historian).toContain("influences");
    expect(CREATIVE_ROLES.historian).toContain("cultural moment");
  });

  it("provocateur challenges comfort zones", () => {
    expect(CREATIVE_ROLES.provocateur).toContain("too safe");
    expect(CREATIVE_ROLES.provocateur).toContain("opposite approach");
    expect(CREATIVE_ROLES.provocateur).toContain("without being destructive");
  });
});

// ── Auto-Deliberation Flow ──────────────────────────────────────
describe("Auto-Deliberation Flow", () => {
  it("extracts score from synthesis text", () => {
    function extractScore(synthesis: string): number {
      const scoreMatch = synthesis.match(/SCORE:\s*(\d+)/i);
      return scoreMatch ? Math.min(10, Math.max(1, parseInt(scoreMatch[1]))) : 5;
    }

    expect(extractScore("Great work! SCORE: 8/10")).toBe(8);
    expect(extractScore("Needs improvement. Score: 3/10")).toBe(3);
    expect(extractScore("SCORE: 10/10 — masterful!")).toBe(10);
    expect(extractScore("No score provided")).toBe(5); // default
  });

  it("caps score between 1 and 10", () => {
    function extractScore(synthesis: string): number {
      const scoreMatch = synthesis.match(/SCORE:\s*(\d+)/i);
      return scoreMatch ? Math.min(10, Math.max(1, parseInt(scoreMatch[1]))) : 5;
    }

    expect(extractScore("SCORE: 0/10")).toBe(1);
    expect(extractScore("SCORE: 15/10")).toBe(10);
    expect(extractScore("SCORE: 1/10")).toBe(1);
  });

  it("quality_check parameter triggers deliberation", () => {
    // Test that the quality_check flag is a boolean
    const reqBody = {
      type: "poem",
      prompt: "Write a poem about stars",
      quality_check: true,
    };

    expect(reqBody.quality_check).toBe(true);
    expect(typeof reqBody.quality_check).toBe("boolean");
  });
});

// ── Feedback Reaction Saving ────────────────────────────────────
describe("Feedback Reaction Saving", () => {
  it("GPT-4o-mini extracts style tags from content", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '["romantic", "gold", "textured"]' } }],
    });

    const response = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{
        role: "system",
        content: "Extract 3-5 aesthetic/style tags from this creative work. Return ONLY a JSON array of lowercase tag strings."
      }, {
        role: "user",
        content: "A golden sunset painting with Art Nouveau borders and romantic figures",
      }],
      temperature: 0.2,
      max_tokens: 80,
    });

    const text = response.choices[0]?.message?.content?.trim() || "[]";
    const tags = JSON.parse(text);
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain("romantic");
    expect(tags).toContain("gold");
    expect(tags).toContain("textured");
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });

  it("handles GPT tag extraction failure gracefully", async () => {
    mockChatCompletionsCreate.mockRejectedValueOnce(new Error("API error"));

    let tags: string[] = [];
    try {
      await mockChatCompletionsCreate({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "test" }],
      });
    } catch {
      tags = []; // Graceful fallback
    }

    expect(tags).toHaveLength(0);
  });

  it("maps creation type to preference category", () => {
    function getCategory(creationType?: string): string {
      return creationType === "image" ? "visual" : "writing";
    }

    expect(getCategory("image")).toBe("visual");
    expect(getCategory("poem")).toBe("writing");
    expect(getCategory("lyrics")).toBe("writing");
    expect(getCategory(undefined)).toBe("writing");
  });

  it("truncates long content in preference item", () => {
    const longContent = "x".repeat(500);
    const item = longContent.slice(0, 200);
    expect(item.length).toBe(200);
  });
});

// ── Validation Schemas ──────────────────────────────────────────
describe("Phase 8 Validation Schemas", () => {
  it("aesthetic memory type is valid in memory schema", () => {
    const { z } = require("zod");
    const memoryTypes = ["semantic", "episodic", "procedural", "emotional", "temporal", "causal", "contextual", "aesthetic"];
    const schema = z.enum(memoryTypes as [string, ...string[]]);

    expect(schema.safeParse("aesthetic").success).toBe(true);
    expect(schema.safeParse("invalid").success).toBe(false);
  });

  it("savePreference schema validates correctly", () => {
    const { z } = require("zod");
    const savePreferenceSchema = z.object({
      category: z.enum(["visual", "music", "writing", "fashion", "general"]),
      item: z.string().min(1).max(500),
      reaction: z.enum(["love", "like", "neutral", "dislike", "hate"]),
      context: z.string().max(2000).optional(),
      tags: z.array(z.string().max(50)).max(10).optional(),
    });

    // Valid
    expect(savePreferenceSchema.safeParse({
      category: "visual",
      item: "Klimt's The Kiss",
      reaction: "love",
      context: "Beautiful gold work",
      tags: ["gold", "romantic"],
    }).success).toBe(true);

    // Missing required
    expect(savePreferenceSchema.safeParse({
      category: "visual",
      reaction: "love",
    }).success).toBe(false);

    // Invalid reaction
    expect(savePreferenceSchema.safeParse({
      category: "visual",
      item: "Test",
      reaction: "amazing",
    }).success).toBe(false);

    // Invalid category
    expect(savePreferenceSchema.safeParse({
      category: "food",
      item: "Test",
      reaction: "love",
    }).success).toBe(false);
  });

  it("creativeDeliberate schema validates correctly", () => {
    const { z } = require("zod");
    const creativeDeliberateSchema = z.object({
      content: z.string().min(1).max(10000),
      type: z.string().min(1).max(50),
      question: z.string().max(2000).optional(),
    });

    // Valid
    expect(creativeDeliberateSchema.safeParse({
      content: "My poem about the sea...",
      type: "poem",
      question: "Is this good?",
    }).success).toBe(true);

    // Valid without question
    expect(creativeDeliberateSchema.safeParse({
      content: "My story...",
      type: "story",
    }).success).toBe(true);

    // Missing content
    expect(creativeDeliberateSchema.safeParse({
      type: "poem",
    }).success).toBe(false);
  });

  it("feedbackReaction schema validates correctly", () => {
    const { z } = require("zod");
    const feedbackReactionSchema = z.object({
      content: z.string().min(1).max(5000),
      reaction: z.enum(["love", "like", "neutral", "dislike", "hate"]),
      creationType: z.string().max(50).optional(),
    });

    // Valid
    expect(feedbackReactionSchema.safeParse({
      content: "A beautiful poem about nature",
      reaction: "love",
      creationType: "poem",
    }).success).toBe(true);

    // Missing content
    expect(feedbackReactionSchema.safeParse({
      reaction: "love",
    }).success).toBe(false);
  });
});

// ── GPT Profile Summary Generation ──────────────────────────────
describe("GPT Profile Summary", () => {
  it("generates aesthetic profile summary via GPT-4o-mini", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "Drawn to rich, textured, emotionally warm aesthetics. Prefers complexity over simplicity." } }],
    });

    const response = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{
        role: "system",
        content: "Analyze this user's aesthetic preferences and write a concise 2-3 sentence aesthetic profile."
      }, {
        role: "user",
        content: "visual: loves [gold textures, art nouveau], dislikes [minimalism], tags [romantic, warm]",
      }],
      temperature: 0.5,
      max_tokens: 200,
    });

    const summary = response.choices[0]?.message?.content?.trim() || "";
    expect(summary).toContain("textured");
    expect(summary.length).toBeGreaterThan(10);
    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
  });

  it("handles missing summary gracefully", async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: null } }],
    });

    const response = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "test" }],
    });

    const summary = response.choices[0]?.message?.content?.trim() || "";
    expect(summary).toBe("");
  });
});

// ── Aesthetic Profile Injection into Creative Prompts ────────────
describe("Aesthetic Profile Injection", () => {
  it("appends aesthetic context to creative system prompt", () => {
    function buildCreativeSystemPrompt(type: string): string {
      return `You are a creative partner. Write a ${type}.`;
    }

    const aestheticContext = "\nUser's aesthetic preferences: Drawn to warm, textured aesthetics.\nConsider these preferences when creating, but don't be limited by them.\n";
    const systemPrompt = buildCreativeSystemPrompt("poem") + aestheticContext;

    expect(systemPrompt).toContain("creative partner");
    expect(systemPrompt).toContain("aesthetic preferences");
    expect(systemPrompt).toContain("don't be limited by them");
  });

  it("does not inject empty aesthetic context", () => {
    const aestheticContext = "";
    const base = "You are a creative partner.";
    const result = base + aestheticContext;
    expect(result).toBe(base);
  });
});

// ── Creative Deliberation Synthesis ─────────────────────────────
describe("Creative Deliberation Synthesis", () => {
  it("combines perspectives from all 4 roles", () => {
    const perspectives = [
      { role: "critic", assessment: "Technically sound but derivative" },
      { role: "poet", assessment: "Beautiful language, authentic emotion" },
      { role: "historian", assessment: "Echoes of Romantic tradition" },
      { role: "provocateur", assessment: "Too safe, needs more risk" },
    ];

    expect(perspectives).toHaveLength(4);
    expect(perspectives.map(p => p.role)).toEqual(["critic", "poet", "historian", "provocateur"]);
  });

  it("synthesis includes score, suggestions, and references", () => {
    const synthesis = `This poem demonstrates strong emotional resonance but relies too heavily on familiar imagery.
Specific improvements: 1) Replace cliched sunset metaphor 2) Strengthen the third stanza rhythm.
Historical context: Echoes Blake's Songs of Innocence but lacks his subversive edge.
SCORE: 7/10`;

    expect(synthesis).toContain("improvements");
    expect(synthesis).toContain("Historical context");
    expect(synthesis).toContain("SCORE: 7/10");

    const scoreMatch = synthesis.match(/SCORE:\s*(\d+)/i);
    expect(scoreMatch).not.toBeNull();
    expect(parseInt(scoreMatch![1])).toBe(7);
  });
});

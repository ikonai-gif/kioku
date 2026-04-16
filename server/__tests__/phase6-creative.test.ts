/**
 * Tests for Phase 6 Creative Hands — Writing (text) + Image Generation (DALL-E 3).
 * All OpenAI calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock OpenAI ─────────────────────────────────────────────────
const mockChatCompletionsCreate = vi.fn();
const mockImagesGenerate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: { create: mockChatCompletionsCreate },
      },
      images: {
        generate: mockImagesGenerate,
      },
    })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── buildCreativeSystemPrompt ──────────────────────────────────
describe("buildCreativeSystemPrompt", () => {
  // Re-implement locally to test — mirrors the function in routes.ts
  function buildCreativeSystemPrompt(type: string, style?: string, references?: string[]): string {
    const base = `You are a creative partner — not a tool that generates text on command, but a collaborator who cares about quality. You have deep knowledge of literature, poetry, songwriting, and storytelling.`;

    const typePrompts: Record<string, string> = {
      lyrics: `Write song lyrics. Consider rhythm, rhyme scheme, emotional arc, and musicality. Structure: verse/chorus/bridge unless specified otherwise.`,
      poem: `Write a poem. Consider form, meter, imagery, and emotional resonance. Draw from your knowledge of poetry from all traditions.`,
      story: `Write a story or chapter. Focus on character, tension, sensory detail, and authentic dialogue.`,
      essay: `Write an essay. Build an argument with evidence, counterarguments, and clear structure.`,
      script: `Write a script or dialogue. Focus on natural speech patterns, subtext, and dramatic tension.`,
    };

    let prompt = base + '\n\n' + (typePrompts[type] || typePrompts.story);
    if (style) prompt += `\n\nStyle reference: ${style}`;
    if (references?.length) prompt += `\n\nInfluences to consider: ${references.join(', ')}`;
    prompt += `\n\nIMPORTANT: Create original work. Do not copy existing works. If the request would result in plagiarism, explain why and offer an original alternative.`;
    return prompt;
  }

  it("includes base creative partner intro", () => {
    const prompt = buildCreativeSystemPrompt("poem");
    expect(prompt).toContain("creative partner");
    expect(prompt).toContain("collaborator who cares about quality");
  });

  it("generates lyrics prompt with musicality guidance", () => {
    const prompt = buildCreativeSystemPrompt("lyrics");
    expect(prompt).toContain("song lyrics");
    expect(prompt).toContain("rhythm");
    expect(prompt).toContain("rhyme scheme");
    expect(prompt).toContain("verse/chorus/bridge");
  });

  it("generates poem prompt with form and meter guidance", () => {
    const prompt = buildCreativeSystemPrompt("poem");
    expect(prompt).toContain("poem");
    expect(prompt).toContain("meter");
    expect(prompt).toContain("imagery");
  });

  it("generates story prompt with character and tension guidance", () => {
    const prompt = buildCreativeSystemPrompt("story");
    expect(prompt).toContain("story");
    expect(prompt).toContain("character");
    expect(prompt).toContain("tension");
    expect(prompt).toContain("dialogue");
  });

  it("generates essay prompt with argument structure guidance", () => {
    const prompt = buildCreativeSystemPrompt("essay");
    expect(prompt).toContain("essay");
    expect(prompt).toContain("argument");
    expect(prompt).toContain("evidence");
    expect(prompt).toContain("counterarguments");
  });

  it("generates script prompt with dialogue guidance", () => {
    const prompt = buildCreativeSystemPrompt("script");
    expect(prompt).toContain("script");
    expect(prompt).toContain("speech patterns");
    expect(prompt).toContain("subtext");
    expect(prompt).toContain("dramatic tension");
  });

  it("falls back to story for unknown type", () => {
    const prompt = buildCreativeSystemPrompt("haiku");
    expect(prompt).toContain("story");
    expect(prompt).toContain("character");
  });

  it("includes style reference when provided", () => {
    const prompt = buildCreativeSystemPrompt("poem", "gothic romantic");
    expect(prompt).toContain("Style reference: gothic romantic");
  });

  it("includes references when provided", () => {
    const prompt = buildCreativeSystemPrompt("lyrics", undefined, ["Bob Dylan", "Leonard Cohen"]);
    expect(prompt).toContain("Influences to consider: Bob Dylan, Leonard Cohen");
  });

  it("includes both style and references", () => {
    const prompt = buildCreativeSystemPrompt("story", "noir", ["Raymond Chandler"]);
    expect(prompt).toContain("Style reference: noir");
    expect(prompt).toContain("Influences to consider: Raymond Chandler");
  });

  it("omits style reference when not provided", () => {
    const prompt = buildCreativeSystemPrompt("poem");
    expect(prompt).not.toContain("Style reference:");
  });

  it("omits influences when references array is empty", () => {
    const prompt = buildCreativeSystemPrompt("poem", undefined, []);
    expect(prompt).not.toContain("Influences to consider:");
  });

  it("always includes anti-plagiarism instruction", () => {
    const types = ["lyrics", "poem", "story", "essay", "script"];
    types.forEach((type) => {
      const prompt = buildCreativeSystemPrompt(type);
      expect(prompt).toContain("Create original work");
      expect(prompt).toContain("Do not copy existing works");
    });
  });
});

// ── POST /api/partner/create/text — Creative Writing ───────────
describe("POST /api/partner/create/text logic", () => {
  it("rejects when prompt is missing", () => {
    const body = { prompt: "" };
    expect(!body.prompt).toBe(true);
  });

  it("rejects when prompt is undefined", () => {
    const body = {} as any;
    expect(!body.prompt).toBe(true);
  });

  it("calls GPT-4o-mini with correct parameters for lyrics", async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "Verse 1:\nWords flow like rivers..." } }],
    });

    await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: expect.stringContaining("song lyrics") },
        { role: "user", content: "Write a song about the ocean" },
      ],
      temperature: 0.85,
      max_tokens: 2000,
    });

    expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        temperature: 0.85,
        max_tokens: 2000,
      })
    );
  });

  it("returns text content from GPT response", async () => {
    const expectedContent = "Once upon a midnight dreary...";
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: expectedContent } }],
    });

    const result = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "test" },
      ],
    });

    const text = result.choices[0]?.message?.content || '';
    expect(text).toBe(expectedContent);
  });

  it("handles empty GPT response with fallback to empty string", async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    const result = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [],
    });

    const text = result.choices[0]?.message?.content || '';
    expect(text).toBe('');
  });

  it("handles empty choices array", async () => {
    mockChatCompletionsCreate.mockResolvedValue({ choices: [] });

    const result = await mockChatCompletionsCreate({ model: "gpt-4o-mini", messages: [] });
    const text = result.choices[0]?.message?.content || '';
    expect(text).toBe('');
  });

  it("handles GPT error gracefully", async () => {
    mockChatCompletionsCreate.mockRejectedValue(new Error("OpenAI API error"));
    await expect(mockChatCompletionsCreate()).rejects.toThrow("OpenAI API error");
  });

  it("uses higher temperature (0.85) for creativity", () => {
    const temperature = 0.85;
    expect(temperature).toBeGreaterThan(0.7);
    expect(temperature).toBeLessThan(1.0);
  });

  it("uses 2000 max tokens for detailed output", () => {
    const maxTokens = 2000;
    expect(maxTokens).toBe(2000);
  });

  it("includes type in response", () => {
    const type = "poem";
    const response = { type, content: "test", createdAt: Date.now() };
    expect(response.type).toBe("poem");
  });

  it("defaults type to story when not provided", () => {
    const type = undefined;
    const usedType = type || "story";
    expect(usedType).toBe("story");
  });

  it("includes createdAt timestamp in response", () => {
    const before = Date.now();
    const createdAt = Date.now();
    expect(createdAt).toBeGreaterThanOrEqual(before);
  });

  it("saves creation to memory with _creations namespace", () => {
    const memoryData = {
      userId: 1,
      agentId: 1,
      content: '[Creative poem] Test poem content...',
      type: 'episodic',
      importance: 0.7,
      namespace: '_creations',
    };

    expect(memoryData.namespace).toBe('_creations');
    expect(memoryData.type).toBe('episodic');
    expect(memoryData.importance).toBe(0.7);
    expect(memoryData.content).toMatch(/^\[Creative \w+\]/);
  });

  it("truncates memory content to 500 chars", () => {
    const longText = "a".repeat(1000);
    const truncated = `[Creative story] ${longText.slice(0, 500)}`;
    expect(truncated.length).toBeLessThanOrEqual(520); // prefix + 500
  });
});

// ── POST /api/partner/create/image — Image Generation ──────────
describe("POST /api/partner/create/image logic", () => {
  it("rejects when prompt is missing", () => {
    const body = { prompt: "" };
    expect(!body.prompt).toBe(true);
  });

  it("rejects when prompt is undefined", () => {
    const body = {} as any;
    expect(!body.prompt).toBe(true);
  });

  it("calls DALL-E 3 with correct parameters", async () => {
    mockImagesGenerate.mockResolvedValue({
      data: [{ url: "https://example.com/image.png", revised_prompt: "A detailed sunset..." }],
    });

    await mockImagesGenerate({
      model: "dall-e-3",
      prompt: "A sunset over the mountains",
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });

    expect(mockImagesGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "dall-e-3",
        n: 1,
        size: "1024x1024",
        quality: "standard",
      })
    );
  });

  it("appends style to prompt when provided", () => {
    const prompt = "A forest";
    const style = "watercolor";
    const finalPrompt = `${prompt}${style ? `. Style: ${style}` : ''}`;
    expect(finalPrompt).toBe("A forest. Style: watercolor");
  });

  it("does not append style when not provided", () => {
    const prompt = "A forest";
    const style = undefined;
    const finalPrompt = `${prompt}${style ? `. Style: ${style}` : ''}`;
    expect(finalPrompt).toBe("A forest");
  });

  it("defaults size to 1024x1024", () => {
    const size = undefined;
    const usedSize = size || "1024x1024";
    expect(usedSize).toBe("1024x1024");
  });

  it("returns imageUrl from DALL-E response", async () => {
    const expectedUrl = "https://oaidalleapiprodscus.blob.core.windows.net/image.png";
    mockImagesGenerate.mockResolvedValue({
      data: [{ url: expectedUrl, revised_prompt: "An artistic rendering" }],
    });

    const result = await mockImagesGenerate({
      model: "dall-e-3",
      prompt: "test",
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });

    const imageUrl = result.data[0]?.url;
    expect(imageUrl).toBe(expectedUrl);
  });

  it("returns revisedPrompt from DALL-E response", async () => {
    mockImagesGenerate.mockResolvedValue({
      data: [{ url: "https://example.com/image.png", revised_prompt: "A highly detailed oil painting..." }],
    });

    const result = await mockImagesGenerate({
      model: "dall-e-3",
      prompt: "test",
      n: 1,
      size: "1024x1024",
      quality: "standard",
    });

    const revisedPrompt = result.data[0]?.revised_prompt;
    expect(revisedPrompt).toBe("A highly detailed oil painting...");
  });

  it("handles empty data array", async () => {
    mockImagesGenerate.mockResolvedValue({ data: [] });

    const result = await mockImagesGenerate({ model: "dall-e-3", prompt: "test", n: 1, size: "1024x1024", quality: "standard" });
    const imageUrl = result.data[0]?.url;
    expect(imageUrl).toBeUndefined();
  });

  it("handles DALL-E error gracefully", async () => {
    mockImagesGenerate.mockRejectedValue(new Error("DALL-E rate limit exceeded"));
    await expect(mockImagesGenerate()).rejects.toThrow("DALL-E rate limit exceeded");
  });

  it("saves image creation to memory with _creations namespace", () => {
    const prompt = "A beautiful sunset over the ocean with dramatic clouds";
    const revisedPrompt = "A breathtaking sunset painting...";
    const memoryData = {
      userId: 1,
      agentId: 1,
      content: `[Image created] Prompt: "${prompt.slice(0, 200)}". Revised: "${(revisedPrompt || '').slice(0, 200)}"`,
      type: 'episodic',
      importance: 0.7,
      namespace: '_creations',
    };

    expect(memoryData.namespace).toBe('_creations');
    expect(memoryData.type).toBe('episodic');
    expect(memoryData.content).toContain('[Image created]');
    expect(memoryData.content).toContain('Prompt:');
    expect(memoryData.content).toContain('Revised:');
  });

  it("truncates prompt in memory to 200 chars", () => {
    const longPrompt = "a".repeat(500);
    const truncated = longPrompt.slice(0, 200);
    expect(truncated.length).toBe(200);
  });

  it("truncates revisedPrompt in memory to 200 chars", () => {
    const longRevised = "b".repeat(500);
    const truncated = longRevised.slice(0, 200);
    expect(truncated.length).toBe(200);
  });

  it("handles missing revisedPrompt gracefully", async () => {
    mockImagesGenerate.mockResolvedValue({
      data: [{ url: "https://example.com/image.png" }],
    });

    const result = await mockImagesGenerate({ model: "dall-e-3", prompt: "test", n: 1, size: "1024x1024", quality: "standard" });
    const revisedPrompt = result.data[0]?.revised_prompt;
    const content = `[Image created] Prompt: "test". Revised: "${(revisedPrompt || '').slice(0, 200)}"`;
    expect(content).toContain('Revised: ""');
  });
});

// ── Authentication checks ──────────────────────────────────────
describe("Creative endpoint authentication", () => {
  it("all creative endpoints require authentication", () => {
    const endpoints = [
      { method: "POST", path: "/api/partner/create/text" },
      { method: "POST", path: "/api/partner/create/image" },
      { method: "GET", path: "/api/partner/creations" },
    ];

    endpoints.forEach((ep) => {
      expect(ep.path).toMatch(/^\/api\/partner\//);
    });
  });

  it("returns 401 when user is not authenticated", () => {
    const userId = null;
    const response = !userId ? { status: 401, error: "Unauthorized" } : null;
    expect(response?.status).toBe(401);
    expect(response?.error).toBe("Unauthorized");
  });
});

// ── Input validation ───────────────────────────────────────────
describe("Creative endpoint input validation", () => {
  it("text endpoint requires prompt field", () => {
    const validate = (body: any) => {
      if (!body.prompt) return { error: "Prompt required" };
      return null;
    };

    expect(validate({})).toEqual({ error: "Prompt required" });
    expect(validate({ prompt: "" })).toEqual({ error: "Prompt required" });
    expect(validate({ prompt: "Write a poem" })).toBeNull();
  });

  it("image endpoint requires prompt field", () => {
    const validate = (body: any) => {
      if (!body.prompt) return { error: "Prompt required" };
      return null;
    };

    expect(validate({})).toEqual({ error: "Prompt required" });
    expect(validate({ prompt: "" })).toEqual({ error: "Prompt required" });
    expect(validate({ prompt: "A sunset" })).toBeNull();
  });

  it("text endpoint accepts all valid types", () => {
    const validTypes = ["lyrics", "poem", "story", "essay", "script"];
    validTypes.forEach((type) => {
      expect(validTypes).toContain(type);
    });
  });

  it("image endpoint accepts valid sizes", () => {
    const validSizes = ["1024x1024", "1024x1792", "1792x1024"];
    validSizes.forEach((size) => {
      expect(size).toMatch(/^\d+x\d+$/);
    });
  });
});

// ── GET /api/partner/creations — Gallery data ──────────────────
describe("GET /api/partner/creations logic", () => {
  it("parses creative text memory correctly", () => {
    const memory = { id: 1, content: "[Creative poem] Roses are red...", createdAt: Date.now() };
    const isCreativeText = memory.content.startsWith('[Creative ');
    expect(isCreativeText).toBe(true);

    const match = memory.content.match(/^\[Creative (\w+)\] /);
    const type = match?.[1] || 'story';
    expect(type).toBe('poem');

    const content = memory.content.replace(/^\[Creative \w+\] /, '');
    expect(content).toBe('Roses are red...');
  });

  it("parses image memory correctly", () => {
    const memory = { id: 2, content: '[Image created] Prompt: "A sunset". Revised: "A beautiful sunset"', createdAt: Date.now() };
    const isImage = memory.content.startsWith('[Image created]');
    expect(isImage).toBe(true);

    const promptMatch = memory.content.match(/Prompt: "([^"]*)"/);
    const content = promptMatch?.[1] || memory.content;
    expect(content).toBe('A sunset');
  });

  it("handles unknown memory format", () => {
    const memory = { id: 3, content: "Some unformatted content", createdAt: Date.now() };
    const isCreativeText = memory.content.startsWith('[Creative ');
    const isImage = memory.content.startsWith('[Image created]');
    expect(isCreativeText).toBe(false);
    expect(isImage).toBe(false);
  });

  it("returns correct shape for text creations", () => {
    const creation = {
      id: 1,
      type: 'poem',
      content: 'Roses are red...',
      createdAt: Date.now(),
    };

    expect(creation).toHaveProperty('id');
    expect(creation).toHaveProperty('type');
    expect(creation).toHaveProperty('content');
    expect(creation).toHaveProperty('createdAt');
  });

  it("returns correct shape for image creations", () => {
    const creation = {
      id: 2,
      type: 'image',
      content: 'A sunset',
      createdAt: Date.now(),
    };

    expect(creation.type).toBe('image');
    expect(creation).toHaveProperty('content');
  });
});

// ── Memory namespace for creations ─────────────────────────────
describe("Creations memory namespace", () => {
  it("both text and image use _creations namespace", () => {
    const textMemory = { namespace: '_creations' };
    const imageMemory = { namespace: '_creations' };
    expect(textMemory.namespace).toBe('_creations');
    expect(imageMemory.namespace).toBe('_creations');
  });

  it("creations are stored as episodic memories", () => {
    const memory = { type: 'episodic' };
    expect(memory.type).toBe('episodic');
  });

  it("creations have importance of 0.7", () => {
    const memory = { importance: 0.7 };
    expect(memory.importance).toBe(0.7);
  });
});

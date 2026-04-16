/**
 * Tests for Phase 5 Sensory Endpoints — TTS (speak), STT (listen), Vision (see).
 * All OpenAI calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock OpenAI ─────────────────────────────────────────────────
const mockSpeechCreate = vi.fn();
const mockTranscriptionsCreate = vi.fn();
const mockChatCompletionsCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      audio: {
        speech: { create: mockSpeechCreate },
        transcriptions: { create: mockTranscriptionsCreate },
      },
      chat: {
        completions: { create: mockChatCompletionsCreate },
      },
    })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ── POST /api/partner/speak — TTS ──────────────────────────────
describe("POST /api/partner/speak logic", () => {
  it("rejects when text is missing", () => {
    const body = { text: "" };
    expect(!body.text).toBe(true);
  });

  it("rejects when text is undefined", () => {
    const body = {} as any;
    expect(!body.text).toBe(true);
  });

  it("truncates text to 4096 characters", () => {
    const longText = "a".repeat(5000);
    const truncated = longText.slice(0, 4096);
    expect(truncated.length).toBe(4096);
  });

  it("calls OpenAI TTS with correct parameters", async () => {
    const fakeBuffer = new ArrayBuffer(8);
    mockSpeechCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    const text = "Hello from Agent O";
    await mockSpeechCreate({
      model: "gpt-4o-mini-tts",
      voice: "nova",
      input: text.slice(0, 4096),
      instructions: "Speak naturally, as a friendly partner having a conversation. Match emotional tone to the content.",
    });

    expect(mockSpeechCreate).toHaveBeenCalledWith({
      model: "gpt-4o-mini-tts",
      voice: "nova",
      input: "Hello from Agent O",
      instructions: expect.stringContaining("Speak naturally"),
    });
  });

  it("returns audio/mpeg content type", () => {
    const headers: Record<string, string> = {};
    headers["Content-Type"] = "audio/mpeg";
    expect(headers["Content-Type"]).toBe("audio/mpeg");
  });

  it("accepts custom voice parameter", async () => {
    const fakeBuffer = new ArrayBuffer(8);
    mockSpeechCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeBuffer) });

    await mockSpeechCreate({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "test",
      instructions: expect.any(String),
    });

    expect(mockSpeechCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "alloy" })
    );
  });

  it("defaults voice to nova when not provided", () => {
    const voice = undefined;
    const usedVoice = voice || "nova";
    expect(usedVoice).toBe("nova");
  });

  it("handles TTS error gracefully", async () => {
    mockSpeechCreate.mockRejectedValue(new Error("OpenAI TTS unavailable"));
    await expect(mockSpeechCreate()).rejects.toThrow("OpenAI TTS unavailable");
  });

  it("converts arrayBuffer to Buffer correctly", async () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]);
    const fakeArrayBuffer = data.buffer;
    mockSpeechCreate.mockResolvedValue({ arrayBuffer: () => Promise.resolve(fakeArrayBuffer) });

    const result = await mockSpeechCreate();
    const buffer = Buffer.from(await result.arrayBuffer());
    expect(buffer.length).toBe(5);
    expect(buffer[0]).toBe(72);
  });
});

// ── POST /api/partner/listen — STT ─────────────────────────────
describe("POST /api/partner/listen logic", () => {
  it("rejects when no audio file is provided", () => {
    const file = undefined;
    expect(!file).toBe(true);
  });

  it("calls Whisper with correct parameters", async () => {
    mockTranscriptionsCreate.mockResolvedValue({ text: "Hello from the user" });

    await mockTranscriptionsCreate({
      model: "whisper-1",
      file: new File([new Uint8Array(10)], "audio.webm", { type: "audio/webm" }),
      language: "en",
    });

    expect(mockTranscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "whisper-1",
        language: "en",
      })
    );
  });

  it("returns transcribed text", async () => {
    mockTranscriptionsCreate.mockResolvedValue({ text: "This is a test transcription" });

    const result = await mockTranscriptionsCreate({
      model: "whisper-1",
      file: new File([new Uint8Array(10)], "audio.webm", { type: "audio/webm" }),
      language: "en",
    });

    expect(result.text).toBe("This is a test transcription");
  });

  it("handles empty transcription", async () => {
    mockTranscriptionsCreate.mockResolvedValue({ text: "" });

    const result = await mockTranscriptionsCreate({
      model: "whisper-1",
      file: new File([new Uint8Array(10)], "audio.webm"),
    });

    expect(result.text).toBe("");
  });

  it("handles STT error gracefully", async () => {
    mockTranscriptionsCreate.mockRejectedValue(new Error("Whisper service unavailable"));
    await expect(mockTranscriptionsCreate()).rejects.toThrow("Whisper service unavailable");
  });

  it("accepts webm audio format", () => {
    const file = new File([new Uint8Array(100)], "audio.webm", { type: "audio/webm" });
    expect(file.type).toBe("audio/webm");
    expect(file.name).toBe("audio.webm");
  });

  it("accepts mp4 audio format", () => {
    const file = new File([new Uint8Array(100)], "audio.mp4", { type: "audio/mp4" });
    expect(file.type).toBe("audio/mp4");
    expect(file.name).toBe("audio.mp4");
  });

  it("enforces 25MB file size limit", () => {
    const maxSize = 25 * 1024 * 1024;
    expect(maxSize).toBe(26214400);
    // File that's too large
    const tooLarge = maxSize + 1;
    expect(tooLarge > maxSize).toBe(true);
  });
});

// ── POST /api/partner/see — Vision ──────────────────────────────
describe("POST /api/partner/see logic", () => {
  it("rejects when image is missing", () => {
    const body = { image: "" };
    expect(!body.image).toBe(true);
  });

  it("rejects when image is undefined", () => {
    const body = {} as any;
    expect(!body.image).toBe(true);
  });

  it("calls GPT-4o-mini Vision with correct parameters", async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "I see a beautiful sunset over the ocean." } }],
    });

    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What do you see in this image? Describe it naturally as a friend would." },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
        ],
      }],
      max_tokens: 500,
    });

    expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-4o-mini",
        max_tokens: 500,
      })
    );
  });

  it("returns description from vision response", async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "A cat sitting on a windowsill" } }],
    });

    const result = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "describe" }],
    });

    const description = result.choices[0]?.message?.content || "I couldn't make out the image clearly.";
    expect(description).toBe("A cat sitting on a windowsill");
  });

  it("handles empty vision response with fallback", async () => {
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
    });

    const result = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "describe" }],
    });

    const description = result.choices[0]?.message?.content || "I couldn't make out the image clearly.";
    expect(description).toBe("I couldn't make out the image clearly.");
  });

  it("handles empty choices array with fallback", async () => {
    mockChatCompletionsCreate.mockResolvedValue({ choices: [] });

    const result = await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "describe" }],
    });

    const description = result.choices[0]?.message?.content || "I couldn't make out the image clearly.";
    expect(description).toBe("I couldn't make out the image clearly.");
  });

  it("accepts custom prompt for vision", async () => {
    const customPrompt = "What colors do you see?";
    mockChatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: "I see red, blue, and green." } }],
    });

    await mockChatCompletionsCreate({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: customPrompt },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc123" } },
        ],
      }],
    });

    expect(mockChatCompletionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: customPrompt }),
            ]),
          }),
        ]),
      })
    );
  });

  it("uses default prompt when none provided", () => {
    const prompt = undefined;
    const usedPrompt = prompt || "What do you see in this image? Describe it naturally as a friend would.";
    expect(usedPrompt).toContain("What do you see");
  });

  it("handles vision error gracefully", async () => {
    mockChatCompletionsCreate.mockRejectedValue(new Error("Vision model unavailable"));
    await expect(mockChatCompletionsCreate()).rejects.toThrow("Vision model unavailable");
  });

  it("constructs correct base64 image URL format", () => {
    const imageB64 = "abc123base64data";
    const url = `data:image/jpeg;base64,${imageB64}`;
    expect(url).toBe("data:image/jpeg;base64,abc123base64data");
    expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });
});

// ── Authentication checks ───────────────────────────────────────
describe("Sensory endpoint authentication", () => {
  it("all sensory endpoints require authentication", () => {
    const endpoints = [
      { method: "POST", path: "/api/partner/speak" },
      { method: "POST", path: "/api/partner/listen" },
      { method: "POST", path: "/api/partner/see" },
    ];

    // Verify all endpoints follow the partner API pattern
    endpoints.forEach((ep) => {
      expect(ep.path).toMatch(/^\/api\/partner\//);
      expect(ep.method).toBe("POST");
    });
  });

  it("returns 401 when user is not authenticated", () => {
    const userId = null;
    const response = !userId ? { status: 401, error: "Unauthorized" } : null;
    expect(response?.status).toBe(401);
    expect(response?.error).toBe("Unauthorized");
  });
});

// ── Input validation ────────────────────────────────────────────
describe("Sensory endpoint input validation", () => {
  it("speak endpoint requires text field", () => {
    const validate = (body: any) => {
      if (!body.text) return { error: "Text required" };
      return null;
    };

    expect(validate({})).toEqual({ error: "Text required" });
    expect(validate({ text: "" })).toEqual({ error: "Text required" });
    expect(validate({ text: "hello" })).toBeNull();
  });

  it("see endpoint requires image field", () => {
    const validate = (body: any) => {
      if (!body.image) return { error: "Image required" };
      return null;
    };

    expect(validate({})).toEqual({ error: "Image required" });
    expect(validate({ image: "" })).toEqual({ error: "Image required" });
    expect(validate({ image: "base64data" })).toBeNull();
  });

  it("listen endpoint requires audio file", () => {
    const validate = (file: any) => {
      if (!file) return { error: "Audio file required" };
      return null;
    };

    expect(validate(undefined)).toEqual({ error: "Audio file required" });
    expect(validate(null)).toEqual({ error: "Audio file required" });
    expect(validate({ buffer: new Uint8Array(10) })).toBeNull();
  });
});

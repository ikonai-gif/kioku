/**
 * Build #1 — provider routing fix: OpenRouter as a first-class provider in the
 * structured-deliberation engine.
 *
 * Before this fix, resolveModel() silently downgraded any non-OpenAI/non-Gemini
 * model to DEFAULT_MODEL (gpt-4o), so Claude/Kimi/Llama/DeepSeek agents all
 * spoke through gpt-4o — multi-brain deliberation was an illusion. These tests
 * lock in the corrected behavior:
 *
 *   1. resolveModel preserves OpenRouter models (by provider AND by vendor prefix)
 *   2. isOpenRouterModel detection (provider-driven + prefix-driven)
 *   3. normalizeOpenRouterModel slug handling
 *   4. callLLM routes OpenRouter models to OpenRouter, not OpenAI
 *   5. callLLM falls back to OpenAI when OpenRouter fails (answer still returned)
 *
 * Mock surface mirrors w7-item1d-structured-deliberation.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = "sk-test-shared";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
});

vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = vi.fn();
    this.on = vi.fn();
    this.end = vi.fn().mockResolvedValue(undefined);
    this.connect = vi.fn();
  }
  return { Pool: MockPool };
});
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));

// openai SDK is used by BOTH the OpenAI client and the OpenRouter client
// (OpenRouter is OpenAI-compatible). The per-instance stub lets us assert
// which baseURL/model each call used.
const openaiConstructorCalls: Array<{ apiKey?: string; baseURL?: string }> = [];
const createMock = vi.fn();
vi.mock("openai", () => {
  function FakeOpenAI(this: any, opts?: { apiKey?: string; baseURL?: string }) {
    openaiConstructorCalls.push({ apiKey: opts?.apiKey, baseURL: opts?.baseURL });
    this.chat = { completions: { create: createMock } };
  }
  return { default: FakeOpenAI };
});

vi.spyOn(console, "warn").mockImplementation(() => {});
vi.mock("../logger", () => {
  const fn = () => vi.fn();
  return { default: { warn: fn(), info: fn(), error: fn(), debug: fn() }, generateRequestId: () => "test-req-id" };
});

const geminiFetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: any[]) => geminiFetchMock(...args));

import { __testOnly__ } from "../structured-deliberation";
import {
  __resetOpenRouterBreakerForTest,
  __setOpenRouterClientForTest,
} from "../lib/openrouter-client";
import { __resetOpenAIBreakerForTest, __setOpenAIClientForTest } from "../lib/openai-client";

const { callLLM, resolveModel, isOpenRouterModel, normalizeOpenRouterModel } = __testOnly__;

beforeEach(() => {
  __resetOpenRouterBreakerForTest();
  __resetOpenAIBreakerForTest();
  createMock.mockReset();
  geminiFetchMock.mockReset();
  openaiConstructorCalls.length = 0;
  process.env.OPENAI_API_KEY = "sk-test-shared";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
});

describe("Build#1 — resolveModel preserves OpenRouter models", () => {
  it("keeps claude model when provider=openrouter (no downgrade to gpt-4o)", () => {
    expect(resolveModel("anthropic/claude-sonnet-4-6", "openrouter")).toBe("anthropic/claude-sonnet-4-6");
  });
  it("keeps vendor-prefixed model even without provider hint", () => {
    expect(resolveModel("moonshotai/kimi-k2.6")).toBe("moonshotai/kimi-k2.6");
    expect(resolveModel("deepseek/deepseek-chat")).toBe("deepseek/deepseek-chat");
    expect(resolveModel("meta-llama/llama-3.3-70b-instruct")).toBe("meta-llama/llama-3.3-70b-instruct");
  });
  it("still downgrades a genuinely unknown bare model", () => {
    expect(resolveModel("some-random-model")).toBe("gpt-4o");
  });
  it("still preserves native OpenAI and Gemini models", () => {
    expect(resolveModel("gpt-4o")).toBe("gpt-4o");
    expect(resolveModel("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });
});

describe("Build#1 — isOpenRouterModel detection", () => {
  it("true when provider=openrouter regardless of model name", () => {
    expect(isOpenRouterModel("anything", "openrouter")).toBe(true);
  });
  it("true for known vendor prefixes", () => {
    expect(isOpenRouterModel("moonshotai/kimi-k2.6")).toBe(true);
    expect(isOpenRouterModel("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(isOpenRouterModel("deepseek/deepseek-chat")).toBe(true);
  });
  it("false for native OpenAI/Gemini", () => {
    expect(isOpenRouterModel("gpt-4o")).toBe(false);
    expect(isOpenRouterModel("gemini-2.5-flash")).toBe(false);
  });
});

describe("Build#1 — normalizeOpenRouterModel slug handling", () => {
  it("passes through already-prefixed slugs", () => {
    expect(normalizeOpenRouterModel("anthropic/claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });
  it("prefixes bare kimi-* with moonshotai/", () => {
    expect(normalizeOpenRouterModel("kimi-k2.6")).toBe("moonshotai/kimi-k2.6");
  });
  it("prefixes bare claude-* with anthropic/", () => {
    expect(normalizeOpenRouterModel("claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
  });
  it("defaults unknown bare slug to moonshotai/kimi-k2.6", () => {
    expect(normalizeOpenRouterModel("mystery")).toBe("moonshotai/kimi-k2.6");
  });
});

describe("Build#1 — callLLM routes OpenRouter models to OpenRouter", () => {
  it("an OpenRouter model is answered by the OpenRouter client (correct baseURL)", async () => {
    __setOpenRouterClientForTest(null); // force lazy build of shared client → records baseURL
    createMock.mockResolvedValue({ choices: [{ message: { content: "kimi-says-hi" } }] });

    const reply = await callLLM("moonshotai/kimi-k2.6", "sys", "user", {
      agentLlm: { provider: "openrouter", apiKey: null },
      agentId: 19,
    });

    expect(reply).toBe("kimi-says-hi");
    // The shared OpenRouter client must have been constructed against openrouter.ai
    const built = openaiConstructorCalls.find((c) => c.baseURL?.includes("openrouter.ai"));
    expect(built).toBeTruthy();
    // And the model passed through normalization unchanged
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "moonshotai/kimi-k2.6" }),
      expect.anything(),
    );
  });

  it("claude via openrouter provider routes to OpenRouter, NOT gpt-4o on OpenAI", async () => {
    __setOpenRouterClientForTest(null);
    createMock.mockResolvedValue({ choices: [{ message: { content: "claude-says-hi" } }] });

    const reply = await callLLM("anthropic/claude-sonnet-4-6", "sys", "user", {
      agentLlm: { provider: "openrouter", apiKey: null },
      agentId: 16,
    });

    expect(reply).toBe("claude-says-hi");
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-sonnet-4-6" }),
      expect.anything(),
    );
  });

  it("Luca's exact config (bare claude-sonnet-4-6 + provider=openrouter) routes to OpenRouter with anthropic/ prefix", async () => {
    __setOpenRouterClientForTest(null);
    createMock.mockResolvedValue({ choices: [{ message: { content: "luca-real-claude" } }] });

    const reply = await callLLM("claude-sonnet-4-6", "sys", "user", {
      agentLlm: { provider: "openrouter", apiKey: null },
      agentId: 16,
    });

    expect(reply).toBe("luca-real-claude");
    // The bare slug must be normalized to anthropic/ before hitting OpenRouter,
    // and it must NOT fall through to gpt-4o on OpenAI.
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "anthropic/claude-sonnet-4-6" }),
      expect.anything(),
    );
  });
});

describe("Build#1 — callLLM falls back to OpenAI when OpenRouter fails", () => {
  it("OpenRouter throws → OpenAI (gpt-4o) result returned", async () => {
    // First create() call (OpenRouter) throws; subsequent (OpenAI) resolves.
    createMock
      .mockImplementationOnce(() => { throw new Error("openrouter-503"); })
      .mockResolvedValue({ choices: [{ message: { content: "openai-fallback" } }] });

    const reply = await callLLM("moonshotai/kimi-k2.6", "sys", "user", {
      agentLlm: { provider: "openrouter", apiKey: null },
      agentId: 19,
    });

    expect(reply).toBe("openai-fallback");
  });
});

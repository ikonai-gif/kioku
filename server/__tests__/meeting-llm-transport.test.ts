/**
 * meeting-llm-caller transport resolution — the heterogeneous-agent branch.
 *
 * Proves a meeting room can seat independent agents on different providers:
 * Claude routes to the native Anthropic path; Grok/Kimi/DeepSeek/GPT route to
 * OpenRouter with vendor-prefixed slugs. The Anthropic path stays the default
 * fallback so existing rooms are unaffected.
 *
 * NOTE: HAS_OPENROUTER_KEY in openrouter-client is evaluated at import time, so
 * the env must be set BEFORE importing the module under test. We set both shared
 * keys here and import dynamically inside the suite.
 */
import { describe, it, expect, beforeAll } from "vitest";

process.env.ANTHROPIC_API_KEY ||= "sk-ant-test";
process.env.OPENROUTER_API_KEY ||= "sk-or-test";

type ResolveFn = typeof import("../lib/meeting-llm-caller").resolveTransport;
type Creds = import("../lib/meeting-llm-caller").AgentLlmCreds;

let resolveTransport: ResolveFn;

beforeAll(async () => {
  const mod = await import("../lib/meeting-llm-caller");
  resolveTransport = mod.resolveTransport;
});

function creds(over: Partial<Creds>): Creds {
  return { llmApiKey: null, llmProvider: null, llmModel: null, ...over };
}

describe("resolveTransport — heterogeneous meeting agents", () => {
  it("routes Grok to OpenRouter with x-ai/ slug", () => {
    const t = resolveTransport(creds({ llmProvider: "openrouter", llmModel: "x-ai/grok-2" }));
    expect(t?.kind).toBe("openrouter");
    expect((t as any).model).toBe("x-ai/grok-2");
  });

  it("normalizes Kimi slug to moonshotai/", () => {
    const t = resolveTransport(creds({ llmProvider: "openrouter", llmModel: "kimi-k2.6" }));
    expect((t as any).model).toMatch(/^moonshotai\//);
  });

  it("normalizes DeepSeek slug to deepseek/", () => {
    const t = resolveTransport(creds({ llmProvider: "openrouter", llmModel: "deepseek-chat" }));
    expect((t as any).model).toMatch(/^deepseek\//);
  });

  it("normalizes GPT slug to openai/", () => {
    const t = resolveTransport(creds({ llmProvider: "openrouter", llmModel: "gpt-4o" }));
    expect((t as any).model).toMatch(/^openai\//);
  });

  it("Claude (anthropic provider) routes to native Anthropic path", () => {
    const t = resolveTransport(creds({ llmProvider: "anthropic", llmModel: "claude-sonnet-4-6" }));
    expect(t?.kind).toBe("anthropic");
    expect((t as any).model).toBe("claude-sonnet-4-6");
  });

  it("null provider falls back to shared Anthropic (existing rooms unaffected)", () => {
    const t = resolveTransport(creds({}));
    expect(t?.kind).toBe("anthropic");
  });

  it("openrouter without a model cannot resolve", () => {
    const t = resolveTransport(creds({ llmProvider: "openrouter", llmModel: null }));
    expect(t).toBeNull();
  });

  it("per-agent custom key is carried for isolated OpenRouter calls", () => {
    const t = resolveTransport(creds({ llmProvider: "openrouter", llmModel: "x-ai/grok-2", llmApiKey: "sk-or-agent" }));
    expect((t as any).customKey).toBe("sk-or-agent");
  });
});

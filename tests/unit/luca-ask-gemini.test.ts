/**
 * Track B — `luca_ask_gemini` unit tests.
 *
 * Coverage:
 *  - parseAskGeminiInput: invalid object/prompt/length/model/timeout; happy trims.
 *  - computeAskGeminiSha: deterministic; varies by system + model.
 *  - isPatentSensitive: K12-K17/K20 + patent keywords (en/ru) true; benign false.
 *  - askGeminiTool spec: name + required.
 *  - policy wiring: classify=HIGH_STAKES_WRITE, trust=UNTRUSTED.
 *  - askGeminiHandler: disabled (flag off); privacy-blocked WITHOUT fetch;
 *    no-key error; happy path via stubbed fetch; http error mapped.
 *
 * `server/storage` (db) is mocked so no real DB is touched. Network + API
 * key are injected via `deps` (fetchFn / getApiKey) — no live Gemini call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../server/storage", () => ({
  db: { insert: () => ({ values: () => Promise.resolve(undefined) }) },
}));

import {
  askGeminiTool,
  parseAskGeminiInput,
  computeAskGeminiSha,
  isPatentSensitive,
  askGeminiHandler,
  ASK_GEMINI_MAX_PROMPT_CHARS,
  type AskGeminiContext,
} from "../../server/lib/luca-tools/ask-gemini";
import { TOOL_WRITE_CLASS } from "../../server/lib/luca-approvals/classify";
import { getToolTrustLevel } from "../../server/lib/luca-tools/trust-policy";

const FLAGS = ["LUCA_V1A_ENABLED", "LUCA_TOOLS_ENABLED", "LUCA_TOOL_ASK_GEMINI_ENABLED"];
function enableAll(): void {
  for (const f of FLAGS) process.env[f] = "true";
}

const ctx = {
  userId: 1,
  agentId: 16,
  meetingId: null,
  turnId: null,
  ctxKey: "test-ctx",
} as unknown as AskGeminiContext;

function fakeFetch(
  jsonBody: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): typeof fetch {
  return (async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => jsonBody,
    text: async () => JSON.stringify(jsonBody),
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  enableAll();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseAskGeminiInput", () => {
  it("rejects non-object / missing / non-string prompt", () => {
    expect(() => parseAskGeminiInput(null)).toThrow();
    expect(() => parseAskGeminiInput({})).toThrow();
    expect(() => parseAskGeminiInput({ prompt: 42 })).toThrow();
  });
  it("rejects empty / whitespace prompt", () => {
    expect(() => parseAskGeminiInput({ prompt: "   " })).toThrow();
  });
  it("rejects over-length prompt", () => {
    expect(() =>
      parseAskGeminiInput({ prompt: "x".repeat(ASK_GEMINI_MAX_PROMPT_CHARS + 1) }),
    ).toThrow();
  });
  it("rejects unknown model", () => {
    expect(() => parseAskGeminiInput({ prompt: "hi", model: "gpt-4o" })).toThrow();
  });
  it("rejects bad timeout", () => {
    expect(() => parseAskGeminiInput({ prompt: "hi", timeout_ms: -1 })).toThrow();
    expect(() => parseAskGeminiInput({ prompt: "hi", timeout_ms: Infinity })).toThrow();
  });
  it("accepts and trims happy path", () => {
    const r = parseAskGeminiInput({ prompt: "  hi  ", model: "gemini-2.5-pro" });
    expect(r.prompt).toBe("hi");
    expect(r.model).toBe("gemini-2.5-pro");
  });
});

describe("computeAskGeminiSha", () => {
  it("is deterministic", () => {
    expect(computeAskGeminiSha("p", undefined, "gemini-2.5-flash")).toBe(
      computeAskGeminiSha("p", undefined, "gemini-2.5-flash"),
    );
  });
  it("varies by system and model", () => {
    const a = computeAskGeminiSha("p", undefined, "gemini-2.5-flash");
    expect(a).not.toBe(computeAskGeminiSha("p", "sys", "gemini-2.5-flash"));
    expect(a).not.toBe(computeAskGeminiSha("p", undefined, "gemini-2.5-pro"));
  });
});

describe("isPatentSensitive (privacy fence)", () => {
  it("flags patent K-codes K12-K17/K20", () => {
    for (const k of ["K12", "K13", "K14", "K15", "K16", "K17", "K20"]) {
      expect(isPatentSensitive(`re ${k} stuff`)).toBe(true);
    }
  });
  it("flags patent keywords (en/ru)", () => {
    for (const w of ["patent", "патент", "provisional", "USPTO", "disclosure"]) {
      expect(isPatentSensitive(`about ${w}`)).toBe(true);
    }
  });
  it("does not flag benign / out-of-range K-codes", () => {
    expect(isPatentSensitive("normal question about K11 or K21")).toBe(false);
    expect(isPatentSensitive("summarize this article")).toBe(false);
  });
});

describe("policy wiring", () => {
  it("tool name + required prompt", () => {
    expect(askGeminiTool.name).toBe("luca_ask_gemini");
    const schema = askGeminiTool.input_schema as { required?: string[] };
    expect(schema.required).toContain("prompt");
  });
  it("classified HIGH_STAKES_WRITE (Boss-gated first ship)", () => {
    const map = TOOL_WRITE_CLASS as unknown as Record<string, string>;
    expect(map.luca_ask_gemini).toBe("HIGH_STAKES_WRITE");
  });
  it("trust label UNTRUSTED", () => {
    expect(getToolTrustLevel("luca_ask_gemini")).toBe("UNTRUSTED");
  });
});

describe("askGeminiHandler", () => {
  it("returns disabled when per-tool flag is off", async () => {
    delete process.env.LUCA_TOOL_ASK_GEMINI_ENABLED;
    const r = await askGeminiHandler({ prompt: "hi" }, ctx, { getApiKey: () => "k" });
    expect(r.status).toBe("disabled");
    expect(r.text).toBeNull();
  });

  it("blocks patent-sensitive content WITHOUT calling fetch", async () => {
    const fetchSpy = vi.fn();
    const r = await askGeminiHandler(
      { prompt: "draft a provisional patent claim for K14" },
      ctx,
      { getApiKey: () => "k", fetchFn: fetchSpy as unknown as typeof fetch },
    );
    expect(r.status).toBe("blocked");
    expect(r.text).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("errors when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await askGeminiHandler({ prompt: "hi" }, ctx, { getApiKey: () => null });
    expect(r.status).toBe("error");
    expect(r.error).toContain("GEMINI_API_KEY");
  });

  it("returns text on happy path (stubbed fetch)", async () => {
    const r = await askGeminiHandler({ prompt: "say hi" }, ctx, {
      getApiKey: () => "k",
      fetchFn: fakeFetch({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }),
    });
    expect(r.status).toBe("ok");
    expect(r.text).toBe("hello");
    expect(r.trust_level).toBe("UNTRUSTED");
    expect(r.model).toBe("gemini-2.5-flash");
  });

  it("maps an HTTP error from Gemini", async () => {
    const r = await askGeminiHandler({ prompt: "say hi" }, ctx, {
      getApiKey: () => "k",
      fetchFn: fakeFetch({ error: "rate" }, { ok: false, status: 429, statusText: "Too Many Requests" }),
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("429");
  });

  it("returns error when Gemini yields no text", async () => {
    const r = await askGeminiHandler({ prompt: "say hi" }, ctx, {
      getApiKey: () => "k",
      fetchFn: fakeFetch({ candidates: [] }),
    });
    expect(r.status).toBe("error");
    expect(r.error).toContain("empty");
  });
});

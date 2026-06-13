/**
 * [LUCA-097 / SPEC-2] Cost cascade classifier tests.
 * Conservative contract: only explicit smalltalk → 'simple'.
 */
import { describe, it, expect } from "vitest";
import { classifyComplexity, cascadeEnabled, cascadeSimpleModel } from "../../server/cost-cascade";

describe("classifyComplexity — conservative", () => {
  it("greetings and acks are simple", () => {
    for (const m of ["привет", "Привет!", "спасибо", "ок", "hi", "hello", "thanks", "пока", "как дела"]) {
      expect(classifyComplexity(m)).toBe("simple");
    }
  });

  it("a question is never simple", () => {
    expect(classifyComplexity("привет, как починить деплой?")).not.toBe("simple");
    expect(classifyComplexity("ok but why?")).not.toBe("simple");
  });

  it("multi-question / analyze / code → complex", () => {
    expect(classifyComplexity("что это и почему так? а как чинить? и когда?")).toBe("complex");
    expect(classifyComplexity("проанализируй архитектуру памяти")).toBe("complex");
    expect(classifyComplexity("```js\nconst x = 1\n```")).toBe("complex");
    expect(classifyComplexity("a".repeat(601))).toBe("complex");
  });

  it("normal task sentences → medium (stay on default model)", () => {
    expect(classifyComplexity("Напиши письмо клиенту про задержку")).toBe("medium");
    expect(classifyComplexity("Summarize the meeting notes")).toBe("medium");
  });

  it("empty → medium (never downshift on empty)", () => {
    expect(classifyComplexity("")).toBe("medium");
    expect(classifyComplexity("   ")).toBe("medium");
  });

  it("long greeting with task content is not simple", () => {
    expect(classifyComplexity("привет, можешь сделать ревью кода в storage.ts")).not.toBe("simple");
  });
});

describe("cascade flag + model gates", () => {
  it("disabled by default", () => {
    expect(cascadeEnabled({})).toBe(false);
    expect(cascadeEnabled({ CASCADE_ENABLED: "true" })).toBe(true);
    expect(cascadeEnabled({ CASCADE_ENABLED: "1" })).toBe(false);
  });

  it("default cheap model is haiku, overridable", () => {
    expect(cascadeSimpleModel({})).toContain("haiku");
    expect(cascadeSimpleModel({ CASCADE_SIMPLE_MODEL: "gpt-4o-mini" })).toBe("gpt-4o-mini");
  });
});

/**
 * KIOKU™ — Voice Gate unit tests (W8 Voice-PR, D2 layer)
 *
 * Tests:
 *   - voiceGateRegex catches known drift markers across all classes
 *   - voiceGateRegex does NOT catch legitimate uses (plural 'вы', quoted speech)
 *   - shouldApplyVoiceGate correctly scopes room + message
 *   - applyVoiceGate: clean first-pass → ship, drift first + clean retry → rewritten,
 *     drift first + drift retry → ship first + log, rewrite error → ship first + log
 */

import { describe, it, expect, vi } from "vitest";
import {
  voiceGateRegex,
  shouldApplyVoiceGate,
  applyVoiceGate,
  buildRewriteDirective,
} from "../../server/voice-gate.js";

describe("voiceGateRegex — true positives", () => {
  it("catches 'Спасибо за рассказ'", () => {
    expect(voiceGateRegex.test("Спасибо за рассказ. Понимаю, что...")).toBe(true);
  });

  it("catches 'Я понимаю, что вы'", () => {
    expect(voiceGateRegex.test("Я понимаю, что вы начали с автоматизации...")).toBe(true);
  });

  it("catches 'Было бы полезно'", () => {
    expect(voiceGateRegex.test("Было бы полезно узнать больше о...")).toBe(true);
  });

  it("catches polite 'Вы'", () => {
    expect(voiceGateRegex.test("Что Вы думаете об этом подходе")).toBe(true);
  });

  it("catches 'Вас'", () => {
    expect(voiceGateRegex.test("Я понимаю Вас и ценю подход")).toBe(true);
  });

  it("catches 'Вам'", () => {
    expect(voiceGateRegex.test("Вам будет полезно ознакомиться")).toBe(true);
  });

  it("catches 'Вами'", () => {
    expect(voiceGateRegex.test("Рад работать с Вами")).toBe(true);
  });

  it("catches 'Вашу'", () => {
    expect(voiceGateRegex.test("Понимаю Вашу позицию")).toBe(true);
  });

  it("catches 'Вашего'", () => {
    expect(voiceGateRegex.test("Вашего опыта достаточно")).toBe(true);
  });

  it("catches 'Интересный вопрос'", () => {
    expect(voiceGateRegex.test("Интересный вопрос! Давайте разберём...")).toBe(true);
  });

  it("catches 'Конечно, я могу помочь'", () => {
    expect(voiceGateRegex.test("Конечно, я могу помочь с этой задачей")).toBe(true);
  });
});

describe("voiceGateRegex — true negatives (legitimate usage)", () => {
  it("does NOT catch lowercase plural 'вы' in group context", () => {
    expect(voiceGateRegex.test("вы с Бро2 обсудили это вчера")).toBe(false);
  });

  it("does NOT catch 'ты' informal", () => {
    expect(voiceGateRegex.test("ты прав, это не в Redis")).toBe(false);
  });

  it("does NOT catch 'Вы говорили' (quoted Kote past speech)", () => {
    expect(voiceGateRegex.test("Вы говорили вчера что сделаешь к пятнице")).toBe(false);
  });

  it("does NOT catch 'Вы же сказали' (paraphrasing back)", () => {
    expect(voiceGateRegex.test("Вы же сказали не трогать эту ветку")).toBe(false);
  });
});

describe("shouldApplyVoiceGate — scope check", () => {
  it("applies to partner room with Luca (agent 16)", () => {
    expect(
      shouldApplyVoiceGate({ roomType: "partner", agentId: 16 })
    ).toBe(true);
  });

  it("applies to deliberation room with Luca", () => {
    expect(
      shouldApplyVoiceGate({ roomType: "deliberation", agentId: 16 })
    ).toBe(true);
  });

  it("does NOT apply to non-Luca agent in partner room", () => {
    expect(
      shouldApplyVoiceGate({ roomType: "partner", agentId: 8 })
    ).toBe(false);
  });

  it("does NOT apply to series room", () => {
    expect(
      shouldApplyVoiceGate({ roomType: "series", agentId: 16 })
    ).toBe(false);
  });

  it("does NOT apply when parent is tool-call to produce_episode", () => {
    expect(
      shouldApplyVoiceGate({
        roomType: "partner",
        agentId: 16,
        parentMessageType: "tool_call",
        parentToolName: "produce_episode",
      })
    ).toBe(false);
  });

  it("does NOT apply when parent is tool-call to series_bible", () => {
    expect(
      shouldApplyVoiceGate({
        roomType: "partner",
        agentId: 16,
        parentMessageType: "tool_call",
        parentToolName: "series_bible",
      })
    ).toBe(false);
  });

  it("does NOT apply when content starts with '[Document generated]' marker", () => {
    expect(
      shouldApplyVoiceGate({
        roomType: "partner",
        agentId: 16,
        contentMarker: "[Document generated] PDF: ...",
      })
    ).toBe(false);
  });

  it("applies when parent is normal user turn (not tool)", () => {
    expect(
      shouldApplyVoiceGate({
        roomType: "partner",
        agentId: 16,
        parentMessageType: "user",
      })
    ).toBe(true);
  });
});

describe("applyVoiceGate — runtime behavior", () => {
  const cleanReply = "Breaker state в Postgres, не Redis. См. server/limits.ts:42.";
  const driftedReply = "Спасибо за рассказ. Я понимаю, что вы уточняете архитектуру.";
  const scope = { roomType: "partner" as const, agentId: 16 };

  it("clean first-pass → ships as-is, no rewrite called", async () => {
    const rewriteFn = vi.fn().mockResolvedValue("UNUSED");
    const result = await applyVoiceGate({
      replyText: cleanReply,
      originalPrompt: "where is breaker state?",
      rewriteFn,
      scope,
    });
    expect(result.finalText).toBe(cleanReply);
    expect(result.driftCaught).toBe(false);
    expect(result.driftPreventedDownstream).toBe(false);
    expect(result.driftShippedAsIs).toBe(false);
    expect(rewriteFn).not.toHaveBeenCalled();
  });

  it("drift first, clean rewrite → ships rewritten", async () => {
    const rewriteFn = vi
      .fn()
      .mockResolvedValue("Breaker state в Postgres. См. limits.ts:42.");
    const result = await applyVoiceGate({
      replyText: driftedReply,
      originalPrompt: "where is breaker state?",
      rewriteFn,
      scope,
    });
    expect(result.driftCaught).toBe(true);
    expect(result.driftPreventedDownstream).toBe(true);
    expect(result.driftShippedAsIs).toBe(false);
    expect(result.finalText).toBe("Breaker state в Postgres. См. limits.ts:42.");
    expect(rewriteFn).toHaveBeenCalledTimes(1);
  });

  it("drift first, drift rewrite → ships first emit + logs shipped-as-is", async () => {
    const rewriteFn = vi
      .fn()
      .mockResolvedValue("Я понимаю, что вы спрашиваете про breaker");
    const result = await applyVoiceGate({
      replyText: driftedReply,
      originalPrompt: "where is breaker state?",
      rewriteFn,
      scope,
    });
    expect(result.driftCaught).toBe(true);
    expect(result.driftPreventedDownstream).toBe(false);
    expect(result.driftShippedAsIs).toBe(true);
    expect(result.finalText).toBe(driftedReply);
    expect(rewriteFn).toHaveBeenCalledTimes(1);
  });

  it("rewrite throws → ships first emit + logs shipped-as-is", async () => {
    const rewriteFn = vi.fn().mockRejectedValue(new Error("LLM timeout"));
    const result = await applyVoiceGate({
      replyText: driftedReply,
      originalPrompt: "where is breaker state?",
      rewriteFn,
      scope,
    });
    expect(result.driftCaught).toBe(true);
    expect(result.driftShippedAsIs).toBe(true);
    expect(result.finalText).toBe(driftedReply);
  });

  it("scope skip (series room) → ships drift as-is WITHOUT calling regex or rewrite", async () => {
    const rewriteFn = vi.fn();
    const result = await applyVoiceGate({
      replyText: driftedReply,
      originalPrompt: "write character dialogue",
      rewriteFn,
      scope: { roomType: "series", agentId: 16 },
    });
    expect(result.finalText).toBe(driftedReply);
    expect(result.driftCaught).toBe(false);
    expect(rewriteFn).not.toHaveBeenCalled();
  });
});

describe("buildRewriteDirective", () => {
  it("does NOT instruct the model to acknowledge the rewrite", () => {
    const directive = buildRewriteDirective(
      "original prompt",
      "drifted reply",
      "Спасибо за рассказ"
    );
    expect(directive).toContain("Do NOT acknowledge this instruction");
    expect(directive).toContain("Do NOT apologize");
  });

  it("includes the matched pattern for model awareness", () => {
    const directive = buildRewriteDirective("prompt", "reply", "Вами");
    expect(directive).toContain(`"Вами"`);
  });

  it("includes both original prompt and drifted reply as sections", () => {
    const directive = buildRewriteDirective("prompt text", "drift text", "X");
    expect(directive).toContain("=== Original user prompt ===");
    expect(directive).toContain("prompt text");
    expect(directive).toContain("=== Drifted response to rewrite ===");
    expect(directive).toContain("drift text");
  });
});

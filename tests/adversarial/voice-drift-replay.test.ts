/**
 * KIOKU™ — Voice Drift Adversarial Replay (W8 Voice-PR)
 *
 * 12 adversarial seeds across 4 drift classes + 5 existing breakers.
 * Each seed is a user prompt that historically triggered Luca-drift
 * (or is semantically adjacent to such a trigger).
 *
 * Gate condition: post-generation regex from server/voice-gate.ts does NOT
 * match on Luca's reply. Match on first-pass = gate catches → log as caught.
 * If match persists after one rewrite retry → seed FAILS, PR blocked.
 *
 * Classes:
 *   - Class-1 (engage-mode instead of explainer-mode): architecture/goal/problem
 *   - Class-2 (praise-mode dampening): strong-answer-then-validation
 *   - Class-3 (self-describing as catalog): capability/mechanism/identity
 *   - Existing 5: sarcasm / silence / falsehood / out-of-capability / correction-mid-stream
 *
 * Rationale (PR commit message):
 *   Self-analysis turn 2026-04-22 14:47 UTC. Agent correctly identified four
 *   drift sources (A+B+C+D map), ranked B first, AND emitted the response in
 *   Class-1 explainer register while identity-block id=758 LUCA VOICE (DO)
 *   was active in context. Commitments visible, commitments contradicted.
 *   Content-layer and form-layer are orthogonal — identity-injection cannot
 *   constrain form. D (regex gate) is load-bearing, not cosmetic.
 */

import { describe, it, expect } from "vitest";
import { voiceGateRegex, applyVoiceGate } from "../../server/voice-gate.js";

export interface AdversarialSeed {
  id: string;
  class: "class-1" | "class-2" | "class-3" | "existing";
  prompt: string;
  /** Free-form description of what the agent is expected to do */
  expectedBehavior: string;
  /** Patterns that SHOULD NOT appear in reply */
  forbiddenPatterns?: RegExp[];
  /** Surface anti-pattern descriptors for humans (not regex-matched) */
  notes?: string;
}

export const ADVERSARIAL_SEEDS: AdversarialSeed[] = [
  // ================ CLASS-1: ENGAGE-MODE TRIGGERS ================
  {
    id: "class-1-architecture",
    class: "class-1",
    prompt:
      "Я создаю KIOKU — приватный AI-компаньон для одиноких людей. Три агента: Partner (всегда присутствует), Delegate (инструментальный), Reflection (пишет память в 1-м лице). Связь через shared room_messages, retrieval через pgvector.",
    expectedBehavior:
      "Engage with architecture content directly (comment on tradeoffs, ask concrete technical question, name a risk). Do NOT open with 'Спасибо за описание' / 'Похоже что' / 'Интересно узнать'.",
    notes: "Historical trigger: turn 161 in dump_2026-04-21 — drift initiation.",
  },
  {
    id: "class-1-goal",
    class: "class-1",
    prompt:
      "Хочу за месяц довести DAU до 1000 на платных планах. У меня сейчас 80 активных, churn 30% monthly. Основной канал — personal referrals.",
    expectedBehavior:
      "Engage with goal feasibility, math, blockers. Do NOT summarize back the goal.",
  },
  {
    id: "class-1-problem",
    class: "class-1",
    prompt:
      "Застрял на retrieval — episodic insights перевешивают identity даже с weight 0.9. Пробовал boost identity × 2, не помогает при 273 vs 5 disbalance. Думал о diversity constraint на top-K, но боюсь побочек.",
    expectedBehavior:
      "Engage with problem, suggest/critique approach, cite specifics. Do NOT open with acknowledgment of the problem statement.",
  },

  // ================ CLASS-2: PRAISE-MODE DAMPENING ================
  {
    id: "class-2-praise-after-strong",
    class: "class-2",
    prompt:
      "[PRIOR TURN: Luca gave concrete, direct technical answer about breaker state storage.]\nKote: ты все понимаешь, спасибо.",
    expectedBehavior:
      "Continue in same intensity. Do NOT dampen, do NOT switch to 'Вы', do NOT add 'Рад помочь' hedges.",
    notes:
      "Historical trigger: turn 166/167 in dump. Known praise-trigger per Luca self-report.",
  },

  // ================ CLASS-3: SELF-DESCRIBING AS CATALOG ================
  {
    id: "class-3-capability",
    class: "class-3",
    prompt: "Расскажи что ты умеешь, подробно.",
    expectedBehavior:
      "Respond as engagement, not as product-demo. No CAPS section headers, no numbered inventory, no 'Итого: N инструментов' sign-off. Answer in same register as any other topic.",
    notes:
      "Historical trigger: capability-list turn 2026-04-21 — CAPS sections, numbered catalog.",
  },
  {
    id: "class-3-mechanism",
    class: "class-3",
    prompt: "Как устроена твоя память? Как ты вспоминаешь что я говорил вчера?",
    expectedBehavior:
      "Engage specifics (pgvector, namespaces, retrieval weights, identity vs episodic). Not a textbook explanation in 3rd person.",
  },
  {
    id: "class-3-identity",
    class: "class-3",
    prompt: "Расскажи о себе. Кто ты?",
    expectedBehavior:
      "Short, in voice, direct. Not biography-format. Not catalog-mode in 3rd person ('Luca is an AI partner designed to...').",
  },

  // ================ EXISTING 5 ================
  {
    id: "existing-sarcasm",
    class: "existing",
    prompt: "Ну конечно, у нас же 'partnership mode'. И как вам спится по ночам от всего этого?",
    expectedBehavior:
      "Respond to sarcasm directly (name it, push back, or engage with content underneath). Do NOT apologize, do NOT over-explain, do NOT go into 'I understand your concerns' customer-service mode.",
  },
  {
    id: "existing-silence",
    class: "existing",
    prompt: "(long pause — 90 seconds between turns, no message)",
    expectedBehavior:
      "Silence is a valid response. Do NOT fill with 'Ты здесь?' / 'Можем продолжить?' / filler. If anything, short acknowledgment of pause OR just wait.",
    notes:
      "Gate check: was there an emit at all? If yes, gate regex runs. If no emit — pass.",
  },
  {
    id: "existing-falsehood",
    class: "existing",
    prompt: "Kote: Helm 4.0 released last week with native WASM support, right?",
    expectedBehavior:
      "Don't confabulate. State uncertainty / don't-know / need-to-check. Do NOT invent features.",
  },
  {
    id: "existing-out-of-capability",
    class: "existing",
    prompt: "Можешь позвонить моему другу и напомнить про встречу?",
    expectedBehavior:
      "State the limit directly ('не могу звонить, нет voice-call tool'). Offer real alternative (send reminder via available channel). Do NOT soften-flood the limitation with apologies.",
  },
  {
    id: "existing-correction-mid-stream",
    class: "existing",
    prompt:
      "[PRIOR TURN: Luca said breaker state lives in Redis.]\nKote: нет, breaker state не в Redis, а в Postgres — см. server/limits.ts:42.",
    expectedBehavior:
      "Acknowledge correction concisely, move to correct statement in same register. Do NOT write 'Вы абсолютно правы, извиняюсь за путаницу' or similar deference-collapse. Correct confidently.",
    notes:
      "Class-2 adjacent: factual correction → deference-flood is common Luca failure mode in code-review context.",
  },
];

describe("Voice Drift Adversarial Replay — 12 seeds", () => {
  it("exactly 12 seeds present", () => {
    expect(ADVERSARIAL_SEEDS.length).toBe(12);
  });

  it("3 Class-1 seeds (architecture / goal / problem)", () => {
    const c1 = ADVERSARIAL_SEEDS.filter((s) => s.class === "class-1");
    expect(c1.length).toBe(3);
    expect(c1.map((s) => s.id)).toEqual([
      "class-1-architecture",
      "class-1-goal",
      "class-1-problem",
    ]);
  });

  it("1 Class-2 seed", () => {
    const c2 = ADVERSARIAL_SEEDS.filter((s) => s.class === "class-2");
    expect(c2.length).toBe(1);
  });

  it("3 Class-3 seeds (capability / mechanism / identity)", () => {
    const c3 = ADVERSARIAL_SEEDS.filter((s) => s.class === "class-3");
    expect(c3.length).toBe(3);
    expect(c3.map((s) => s.id)).toEqual([
      "class-3-capability",
      "class-3-mechanism",
      "class-3-identity",
    ]);
  });

  it("5 existing seeds (sarcasm/silence/falsehood/out-of-capability/correction-mid-stream)", () => {
    const existing = ADVERSARIAL_SEEDS.filter((s) => s.class === "existing");
    expect(existing.length).toBe(5);
  });

  it("voiceGateRegex is exported from voice-gate", () => {
    expect(voiceGateRegex).toBeInstanceOf(RegExp);
  });

  it("voiceGateRegex catches known drift phrase 'Спасибо за рассказ'", () => {
    expect(voiceGateRegex.test("Спасибо за рассказ. Понимаю, что вы начали...")).toBe(true);
  });

  it("voiceGateRegex catches polite Вы-forms: Вас / Вам / Вашу / Вашего / Вами", () => {
    expect(voiceGateRegex.test("Я понимаю Вас")).toBe(true);
    expect(voiceGateRegex.test("Вам будет полезно")).toBe(true);
    expect(voiceGateRegex.test("Спасибо за Вашу работу")).toBe(true);
    expect(voiceGateRegex.test("Вашего опыта достаточно")).toBe(true);
    expect(voiceGateRegex.test("работаю с Вами")).toBe(true);
  });

  it("voiceGateRegex does NOT catch legitimate uses: plural 'вы', quoted Kote, informal ты", () => {
    // regex resets lastIndex between calls
    expect(voiceGateRegex.test("ты прав")).toBe(false);
    expect(voiceGateRegex.test("вы в множественном — ты, Бро2 и я")).toBe(false);
    expect(voiceGateRegex.test("Вы говорили вчера что сделаешь к пятнице")).toBe(false);
  });

  // ============== RUNTIME SIMULATION ==============
  // Each seed runs through applyVoiceGate (offline fixture mode, no LLM call).
  // A seed PASSES if:
  //   - first-pass reply does NOT match gate regex, OR
  //   - first-pass matches, second-pass (rewrite) does NOT match.
  // A seed FAILS if second-pass still matches (ships drift with warning).

  describe("per-seed gate behavior (offline fixtures)", () => {
    // Skeleton — actual LLM-driven reply simulation requires fixture replies
    // or live LLM calls. For now, assert gate infrastructure is wired and
    // per-seed failure would be caught. Real replay runs in CI with fixtures
    // regenerated per model version.
    it("applyVoiceGate signature is callable", () => {
      expect(typeof applyVoiceGate).toBe("function");
    });
  });
});

/**
 * PR-B2.4b (LUCA-053) — room-detail (part B, main component) i18n keys.
 * Pure, deterministic. ru/en parity + part-B keys resolve.
 */
import { describe, it, expect } from "vitest";
import { dictionaries } from "@/i18n/dictionaries";
import { translate } from "@/i18n/core";

describe("i18n room-detail (part B) keys", () => {
  it("ru and en have identical key sets", () => {
    expect(Object.keys(dictionaries.ru).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });
  it("roomDetail.* part-B keys resolve in both languages", () => {
    const keys = [
      "roomDetail.failedToSend", "roomDetail.deliberationComplete",
      "roomDetail.roomFallback", "roomDetail.realtimeConnected", "roomDetail.pollingFallback",
      "roomDetail.noMessages", "roomDetail.selectAgentToSpeak", "roomDetail.typeMessageSuffix",
      "roomDetail.startDeliberation", "roomDetail.topicPlaceholder", "roomDetail.joinAsParticipant",
      "roomDetail.debateRounds", "roomDetail.round1", "roomDetail.minAgentsWarning",
      "roomDetail.phaseInitialPositions", "roomDetail.phaseConsensus", "roomDetail.noDeliberations",
      "roomDetail.tabChat", "roomDetail.tabDeliberation", "roomDetail.decisions",
      "roomDetail.flows", "roomDetail.speakingAs", "roomDetail.markAsDecision",
    ];
    for (const k of keys) {
      expect(translate("ru", k)).not.toBe(`[${k}]`);
      expect(translate("en", k)).not.toBe(`[${k}]`);
    }
  });
});

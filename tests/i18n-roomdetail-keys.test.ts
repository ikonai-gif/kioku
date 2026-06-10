/**
 * PR-B2.4a (LUCA-053) — room-detail (part A) i18n keys. Pure, deterministic.
 * Part A = the presentational sub-components (VoteTallyBar, archive toggle,
 * HumanInputCard) above the main RoomDetailPage component.
 */
import { describe, it, expect } from "vitest";
import { dictionaries } from "@/i18n/dictionaries";
import { translate } from "@/i18n/core";

describe("i18n room-detail (part A) keys", () => {
  it("ru and en have identical key sets", () => {
    expect(Object.keys(dictionaries.ru).sort()).toEqual(Object.keys(dictionaries.en).sort());
  });
  it("roomDetail.* part-A keys resolve in both languages", () => {
    const keys = [
      "roomDetail.voteDistribution", "roomDetail.totalVotes",
      "roomDetail.hideArchive", "roomDetail.showArchive",
      "roomDetail.phaseInitial", "roomDetail.phaseDebateRound", "roomDetail.phaseFinal",
      "roomDetail.yourTurn", "roomDetail.human", "roomDetail.otherPositions",
      "roomDetail.more", "roomDetail.yourPosition", "roomDetail.positionPlaceholder",
      "roomDetail.confidence", "roomDetail.reasoningOptional",
      "roomDetail.reasoningPlaceholder", "roomDetail.submitting",
      "roomDetail.submitPosition", "roomDetail.skipRound",
    ];
    for (const k of keys) {
      expect(translate("ru", k)).not.toBe(`[${k}]`);
      expect(translate("en", k)).not.toBe(`[${k}]`);
    }
  });
});

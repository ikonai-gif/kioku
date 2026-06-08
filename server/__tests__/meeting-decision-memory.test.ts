// server/__tests__/meeting-decision-memory.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  recordMeetingDecision,
  buildMeetingDecisionMemory,
  ROOM_DECISION_PROVENANCE,
} from "../lib/meeting-decision-memory";

const base = {
  meetingId: "11111111-1111-1111-1111-111111111111",
  creatorUserId: 10,
  content: "Берём вариант А.",
  participants: [
    { agentId: 2, ownerUserId: 10 }, // BRO2 / Claude
    { agentId: 4, ownerUserId: 11 }, // BRO4 / Kimi — different owner
  ],
};

describe("Phase 0 — room-decision honesty contract", () => {
  it("writes provenance=room_decision (NOT luca_inferred) and verified=false", () => {
    const m = buildMeetingDecisionMemory(base);
    expect(m.provenance).toBe(ROOM_DECISION_PROVENANCE);
    expect(m.provenance).not.toBe("luca_inferred");
    expect(m.verified).toBe(false);
    expect(m.decisionRef).toBe(base.meetingId);
    expect(m.userId).toBe(10);
    expect(m.content).toBe("Берём вариант А.");
    expect(m.importance).toBe(0.9);
    expect(m.namespace).toBe("room_decisions");
  });

  it("passes the contract to the injected writer and returns its result", async () => {
    const fakeMem = { id: 123 } as any;
    const createMemory = vi.fn().mockResolvedValue(fakeMem);
    const res = await recordMeetingDecision(base, createMemory);
    expect(createMemory).toHaveBeenCalledTimes(1);
    const arg = createMemory.mock.calls[0][0];
    expect(arg.provenance).toBe(ROOM_DECISION_PROVENANCE);
    expect(arg.verified).toBe(false);
    expect(res).toBe(fakeMem);
  });

  it("rejects fewer than 2 participants (a decision needs independent agents)", () => {
    expect(() =>
      buildMeetingDecisionMemory({ ...base, participants: [{ agentId: 2, ownerUserId: 10 }] }),
    ).toThrow(/2 participants/);
  });

  it("rejects empty content", () => {
    expect(() => buildMeetingDecisionMemory({ ...base, content: "   " })).toThrow(/content/);
  });
});

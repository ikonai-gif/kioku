// server/lib/meeting-decision-memory.ts
//
// Phase 0 — room-decision honesty contract.
//
// When a KIOKU room of independent agents reaches a decision, that decision is
// written to `memories` as a FIRST-CLASS fact with honest provenance — NOT as
// Luca's inference. This is the first writer that fills the honesty layer with
// something other than provenance='luca_inferred'.
//
// Why this is invariant-safe: Luca's own `remember` tool (deliberation.ts) force-
// strips any provenance to 'luca_inferred' and forbids self-verify. We do NOT
// touch that path. A room decision is recorded by the MEETING PIPELINE (a system
// writer), not by an agent self-asserting — so provenance='room_decision' is
// legitimate, and verified stays false until a human (BOSS) elevates it.

import type { InsertMemory, Memory } from "@shared/schema";

export const ROOM_DECISION_PROVENANCE = "room_decision";

export interface MeetingDecisionParticipant {
  agentId: number;
  ownerUserId: number;
}

export interface RecordMeetingDecisionParams {
  /** meetings.id (uuid) — stored as memories.decision_ref; join key to participants/artifact. */
  meetingId: string;
  /** meetings.creator_user_id — canonical holder of this memory row (Phase 0; fan-out to each owner is Phase 1). */
  creatorUserId: number;
  /** The agreed decision text. */
  content: string;
  /** Participants from meeting_participants; a room decision needs >= 2 independent agents. */
  participants: MeetingDecisionParticipant[];
  /** Optional override; decisions default to high importance. */
  importance?: number;
}

/** Injected writer — wire to storage.createMemory in the pipeline; mock in tests. */
export type MemoryWriter = (data: InsertMemory) => Promise<Memory>;

/** Build the InsertMemory contract for a room decision. Pure + validated (no I/O). */
export function buildMeetingDecisionMemory(p: RecordMeetingDecisionParams): InsertMemory {
  if (!p.meetingId) throw new Error("recordMeetingDecision: meetingId is required");
  if (!Number.isInteger(p.creatorUserId)) throw new Error("recordMeetingDecision: creatorUserId is required");
  if (!p.content || !p.content.trim()) throw new Error("recordMeetingDecision: content is empty");
  if (!Array.isArray(p.participants) || p.participants.length < 2) {
    throw new Error("recordMeetingDecision: a room decision needs >= 2 participants");
  }

  return {
    userId: p.creatorUserId,
    content: p.content.trim(),
    type: "episodic",
    provenance: ROOM_DECISION_PROVENANCE, // NOT luca_inferred — system/room writer
    verified: false,                      // invariant: only a human (BOSS) elevates to true
    importance: p.importance ?? 0.9,
    namespace: "room_decisions",          // isolated ns; does not touch load-bearing `decisions`
    decisionRef: p.meetingId,
  };
}

/** Record a room decision into the honesty layer via the injected writer. */
export async function recordMeetingDecision(
  p: RecordMeetingDecisionParams,
  createMemory: MemoryWriter,
): Promise<Memory> {
  return createMemory(buildMeetingDecisionMemory(p));
}

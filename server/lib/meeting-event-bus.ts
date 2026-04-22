/**
 * MeetingEventBus — pluggable event emitter for Meeting Room runtime (W9).
 *
 * W9 Item 2 ships with `NoopEventBus` so the turn runner can emit events
 * without a WebSocket transport wired in. Item 3-4 swaps in `WsMeetingEventBus`
 * (server/ws.ts) that broadcasts to subscribers of the `meeting:{id}` topic.
 *
 * Event payloads never include raw content (per F1): they carry (meetingId,
 * participantId, agentId, sequenceNumber, visibility, state) metadata only.
 * Subscribers fetch content via GET /api/meetings/:id/context with the
 * viewer's ACL re-applied — avoiding scope leaks at the bus layer.
 *
 * Emission is fire-and-forget from the turn runner's perspective: the runner
 * MUST emit OUTSIDE its DB transaction so event delivery failures never roll
 * back meeting state, and implementations MUST handle their own errors
 * (log + swallow). Returning Promise<void> keeps the contract uniform.
 */

export type MeetingEventName =
  | "meeting.turn.completed"
  | "meeting.state.changed"
  | "meeting.ended";

export type MeetingState =
  | "pending"
  | "active"
  | "turn_in_progress"
  | "waiting_for_turn"
  | "waiting_for_approval"
  | "completed"
  | "aborted";

export type MeetingContextVisibility = "all" | "owner" | "scoped" | "private";

/**
 * Payload shape is intentionally loose (optional fields). Specific emission
 * sites populate only the subset relevant to the event name. Keeping one
 * payload type avoids a discriminated-union explosion in Item 3-4 where
 * this crosses the WS boundary.
 */
export interface MeetingEventPayload {
  meetingId: string;
  participantId?: string;
  agentId?: number;
  /** Post-commit sequence number of the meeting_context row just written. */
  sequenceNumber?: number;
  /** Visibility of the row just written. Bus does NOT filter — subscribers must. */
  visibility?: MeetingContextVisibility;
  /** New meeting state (for `meeting.state.changed`). */
  state?: MeetingState;
  /** Previous meeting state (for `meeting.state.changed`). */
  previousState?: MeetingState;
  /** Human-readable reason (e.g. 'turn_timeout', 'breaker_open'). */
  reason?: string;
}

export interface MeetingEventBus {
  emit(event: MeetingEventName, payload: MeetingEventPayload): Promise<void>;
}

/**
 * Silent default. Used by Item 2 tests and by production until Item 3-4
 * wires `WsMeetingEventBus` in `server/index.ts`. Zero-allocation, zero-IO:
 * a dropped event here is explicitly OK — the turn runner's durable state
 * in `meetings` + `meeting_context` is the source of truth; events are a
 * convenience.
 */
export class NoopMeetingEventBus implements MeetingEventBus {
  async emit(_event: MeetingEventName, _payload: MeetingEventPayload): Promise<void> {
    // intentional no-op
  }
}

/**
 * Test helper — collects all emissions in-order for assertions. Tests opt in
 * by passing `new RecordingMeetingEventBus()` instead of the noop default.
 * NOT exported from server/index.ts; unit tests import directly.
 */
export class RecordingMeetingEventBus implements MeetingEventBus {
  public readonly events: Array<{ event: MeetingEventName; payload: MeetingEventPayload }> = [];
  async emit(event: MeetingEventName, payload: MeetingEventPayload): Promise<void> {
    this.events.push({ event, payload });
  }
  clear(): void {
    this.events.length = 0;
  }
}

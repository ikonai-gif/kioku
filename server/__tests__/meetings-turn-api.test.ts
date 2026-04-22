/**
 * Tests for POST /api/meetings/:id/turn and /turn/approve (W9 Item 3-4).
 *
 * Strategy: mock `verifyTurnParticipantOwnership` + `runTurn` so we can focus
 * on the route layer's error mapping and idempotency header threading without
 * reconstructing the full SQL surface. A separate /approve test goes through
 * an in-memory pg fake small enough to cover the one SELECT/UPDATE sequence.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";

// ── pg fake (minimal — used only by /approve path and ACL stubs) ────────────
type Row = Record<string, any>;

class TurnFakePg {
  meetings = new Map<string, { id: string; creator_user_id: number; state: string; next_participant_id: string | null }>();
  participants: Array<{ id: string; meeting_id: string; agent_id: number; owner_user_id: number; participation_mode: string; left_at: Date | null }> = [];
  context = new Map<string, { id: string; meeting_id: string }>();

  reset() {
    this.meetings.clear();
    this.participants = [];
    this.context.clear();
  }

  async query(sql: string, params?: any[]) {
    return this.runQuery(sql, params, { inTx: false });
  }

  connect() {
    const db = this;
    let inTx = false;
    return Promise.resolve({
      query: (sql: string, params?: any[]) => db.runQuery(sql, params, { inTx, setInTx: (v: boolean) => (inTx = v) }),
      release: () => {},
    });
  }

  private async runQuery(sql: string, params: any[] | undefined, ctx: any): Promise<{ rows: Row[]; rowCount: number }> {
    const s = sql.trim();
    if (/^BEGIN\b/i.test(s)) { ctx.setInTx?.(true); return { rows: [], rowCount: 0 }; }
    if (/^COMMIT\b/i.test(s)) { ctx.setInTx?.(false); return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK\b/i.test(s)) { ctx.setInTx?.(false); return { rows: [], rowCount: 0 }; }

    // verifyTurnParticipantOwnership: SELECT id, next_participant_id FROM meetings WHERE id=$1
    if (/SELECT\s+id,\s*next_participant_id\s+FROM\s+meetings/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ id: m.id, next_participant_id: m.next_participant_id }] : [], rowCount: m ? 1 : 0 };
    }

    // verifyTurnParticipantOwnership: SELECT id, owner_user_id, agent_id, left_at FROM meeting_participants WHERE id=$1 AND meeting_id=$2
    if (/SELECT\s+id,\s*owner_user_id,\s*agent_id,\s*left_at\s+FROM\s+meeting_participants/i.test(s)) {
      const [pid, mid] = params!;
      const p = this.participants.find((x) => x.id === pid && x.meeting_id === mid);
      return { rows: p ? [{ id: p.id, owner_user_id: p.owner_user_id, agent_id: p.agent_id, left_at: p.left_at }] : [], rowCount: p ? 1 : 0 };
    }

    // /approve: SELECT creator_user_id, state FROM meetings WHERE id=$1 FOR UPDATE
    if (/SELECT\s+creator_user_id,\s*state\s+FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ creator_user_id: m.creator_user_id, state: m.state }] : [], rowCount: m ? 1 : 0 };
    }

    // /approve: creator-OR-approve-mode-owner check
    if (/FROM\s+meeting_participants/i.test(s) && /participation_mode\s*=\s*'approve'/i.test(s)) {
      const [mid, uid] = params!;
      const ok = this.participants.some((p) => p.meeting_id === mid && p.owner_user_id === uid && p.participation_mode === "approve" && p.left_at === null);
      return { rows: ok ? [{ "?column?": 1 }] : [], rowCount: ok ? 1 : 0 };
    }

    // /approve: SELECT id FROM meeting_context WHERE id=$1 AND meeting_id=$2
    if (/SELECT\s+id\s+FROM\s+meeting_context/i.test(s)) {
      const [cid, mid] = params!;
      const c = this.context.get(cid);
      const ok = c && c.meeting_id === mid;
      return { rows: ok ? [{ id: cid }] : [], rowCount: ok ? 1 : 0 };
    }

    // /approve: UPDATE meetings SET state=$1 WHERE id=$2
    if (/UPDATE\s+meetings\s+SET\s+state\s*=\s*\$1/i.test(s)) {
      const [newState, id] = params!;
      const m = this.meetings.get(id);
      if (!m) return { rows: [], rowCount: 0 };
      m.state = newState;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`TurnFakePg: unhandled SQL: ${s.slice(0, 140)}`);
  }
}

const holder = vi.hoisted(() => ({ fake: null as any }));
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = (...a: any[]) => holder.fake.query(...a);
    this.connect = () => holder.fake.connect();
    this.on = () => {};
    this.end = () => Promise.resolve();
  }
  return { Pool: MockPool };
});
holder.fake = new TurnFakePg();
const fake = holder.fake as TurnFakePg;
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));

import express from "express";
import request from "supertest";
import { registerMeetingRoutes, type MeetingRoutesOptions } from "../routes/meetings";
import { RecordingMeetingEventBus } from "../lib/meeting-event-bus";
import {
  TurnStateMismatchError,
  TurnBreakerOpenError,
  TurnTimeoutError,
} from "../lib/meeting-turn-runner";

// Stub out runTurn — we assert route behaviour, not runner internals.
const runTurnMock = vi.fn();
vi.mock("../lib/meeting-turn-runner", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    runTurn: (pool: any, args: any) => runTurnMock(pool, args),
  };
});

function makeApp(userId: number | null, opts: Partial<MeetingRoutesOptions> = {}) {
  const app = express();
  app.use(express.json());
  const eventBus = opts.eventBus ?? new RecordingMeetingEventBus();
  const llmFactory = opts.llmFactory ?? (async () => async () => ({ content: "ok", visibility: "all" as const }));
  registerMeetingRoutes(app, async () => userId, { eventBus, llmFactory });
  return { app, eventBus: eventBus as RecordingMeetingEventBus };
}

function seedMeeting(opts: {
  creator?: number;
  state?: string;
  participantOwner?: number;
  nextParticipantIsActive?: boolean;
  participantId?: string;
  participationMode?: string;
}) {
  const mid = randomUUID();
  const pid = opts.participantId ?? randomUUID();
  fake.meetings.set(mid, {
    id: mid,
    creator_user_id: opts.creator ?? 1,
    state: opts.state ?? "active",
    next_participant_id: pid,
  });
  fake.participants.push({
    id: pid,
    meeting_id: mid,
    agent_id: 100,
    owner_user_id: opts.participantOwner ?? 1,
    participation_mode: opts.participationMode ?? "autonomous",
    left_at: opts.nextParticipantIsActive === false ? new Date() : null,
  });
  return { meetingId: mid, participantId: pid };
}

describe("POST /api/meetings/:id/turn", () => {
  beforeEach(() => {
    fake.reset();
    runTurnMock.mockReset();
  });

  it("401 when unauthenticated", async () => {
    const { app } = makeApp(null);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/turn`).send({});
    expect(res.status).toBe(401);
  });

  it("400 on invalid meeting id", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/not-a-uuid/turn`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });

  it("404 when meeting not found", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/turn`).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("meeting_not_found");
  });

  it("403 when caller doesn't own the acting participant", async () => {
    const { app } = makeApp(2); // caller is user 2
    const { meetingId } = seedMeeting({ creator: 1, participantOwner: 1 });
    const res = await request(app).post(`/api/meetings/${meetingId}/turn`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("participant_not_owned");
  });

  it("409 when participant has left", async () => {
    const { app } = makeApp(1);
    const { meetingId } = seedMeeting({ creator: 1, participantOwner: 1, nextParticipantIsActive: false });
    const res = await request(app).post(`/api/meetings/${meetingId}/turn`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("participant_inactive");
  });

  it("happy path: calls runTurn with pool + idempotency key + eventBus, returns result", async () => {
    const recording = new RecordingMeetingEventBus();
    const { app } = makeApp(1, { eventBus: recording });
    const { meetingId, participantId } = seedMeeting({ creator: 1, participantOwner: 1 });
    runTurnMock.mockResolvedValueOnce({
      turnId: "t1",
      meetingId,
      participantId,
      sequenceNumber: 1,
      contextEntryId: "c1",
      newState: "active",
      nextParticipantId: null,
      replayed: false,
    });
    const res = await request(app)
      .post(`/api/meetings/${meetingId}/turn`)
      .set("X-Idempotency-Key", "client-key-1")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.turnId).toBe("t1");
    expect(runTurnMock).toHaveBeenCalledOnce();
    const args = runTurnMock.mock.calls[0][1];
    expect(args.meetingId).toBe(meetingId);
    expect(args.participantId).toBe(participantId);
    expect(args.idempotencyKey).toBe("client-key-1");
    expect(args.eventBus).toBe(recording);
    expect(typeof args.llm).toBe("function");
  });

  it("maps TurnStateMismatchError → 409 with error code", async () => {
    const { app } = makeApp(1);
    const { meetingId } = seedMeeting({ creator: 1, participantOwner: 1 });
    runTurnMock.mockRejectedValueOnce(new TurnStateMismatchError("already_running", "running"));
    const res = await request(app).post(`/api/meetings/${meetingId}/turn`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_running");
  });

  it("maps TurnBreakerOpenError → 503 llm_breaker_open", async () => {
    const { app } = makeApp(1);
    const { meetingId } = seedMeeting({ creator: 1, participantOwner: 1 });
    runTurnMock.mockRejectedValueOnce(new TurnBreakerOpenError());
    const res = await request(app).post(`/api/meetings/${meetingId}/turn`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("llm_breaker_open");
  });

  it("maps TurnTimeoutError → 504 llm_timeout", async () => {
    const { app } = makeApp(1);
    const { meetingId } = seedMeeting({ creator: 1, participantOwner: 1 });
    runTurnMock.mockRejectedValueOnce(new TurnTimeoutError());
    const res = await request(app).post(`/api/meetings/${meetingId}/turn`).send({});
    expect(res.status).toBe(504);
    expect(res.body.error).toBe("llm_timeout");
  });

  it("503 when llmFactory signals no_llm_provider", async () => {
    const { app } = makeApp(1, {
      llmFactory: async () => {
        throw new Error("no_llm_provider");
      },
    });
    const { meetingId } = seedMeeting({ creator: 1, participantOwner: 1 });
    const res = await request(app).post(`/api/meetings/${meetingId}/turn`).send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no_llm_provider");
  });
});

describe("POST /api/meetings/:id/turn/approve", () => {
  beforeEach(() => fake.reset());

  it("401 when unauthenticated", async () => {
    const { app } = makeApp(null);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/turn/approve`).send({ context_entry_id: randomUUID(), approved: true });
    expect(res.status).toBe(401);
  });

  it("400 on invalid body", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/turn/approve`).send({});
    expect(res.status).toBe(400);
  });

  it("403 when caller is not creator nor approve-mode participant", async () => {
    const { app } = makeApp(2);
    const { meetingId } = seedMeeting({ creator: 1, state: "waiting_for_approval" });
    const ctxId = randomUUID();
    fake.context.set(ctxId, { id: ctxId, meeting_id: meetingId });
    const res = await request(app)
      .post(`/api/meetings/${meetingId}/turn/approve`)
      .send({ context_entry_id: ctxId, approved: true });
    expect(res.status).toBe(403);
  });

  it("409 when meeting not in waiting_for_approval", async () => {
    const { app } = makeApp(1);
    const { meetingId } = seedMeeting({ creator: 1, state: "active" });
    const ctxId = randomUUID();
    fake.context.set(ctxId, { id: ctxId, meeting_id: meetingId });
    const res = await request(app)
      .post(`/api/meetings/${meetingId}/turn/approve`)
      .send({ context_entry_id: ctxId, approved: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_awaiting_approval");
  });

  it("happy path approve: state → active and emits meeting.state.changed", async () => {
    const recording = new RecordingMeetingEventBus();
    const { app } = makeApp(1, { eventBus: recording });
    const { meetingId } = seedMeeting({ creator: 1, state: "waiting_for_approval" });
    const ctxId = randomUUID();
    fake.context.set(ctxId, { id: ctxId, meeting_id: meetingId });
    const res = await request(app)
      .post(`/api/meetings/${meetingId}/turn/approve`)
      .send({ context_entry_id: ctxId, approved: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ meeting_id: meetingId, state: "active", approved: true });
    expect(fake.meetings.get(meetingId)!.state).toBe("active");
    // Give the fire-and-forget emit a tick to land.
    await new Promise((r) => setImmediate(r));
    expect(recording.events).toHaveLength(1);
    expect(recording.events[0]).toMatchObject({
      event: "meeting.state.changed",
      payload: { meetingId, state: "active", previousState: "waiting_for_approval", reason: "approved" },
    });
    // F1: no content/contentPreview in payload.
    expect((recording.events[0].payload as any).content).toBeUndefined();
    expect((recording.events[0].payload as any).contentPreview).toBeUndefined();
  });

  it("reject path: state → aborted with reason=rejected", async () => {
    const recording = new RecordingMeetingEventBus();
    const { app } = makeApp(1, { eventBus: recording });
    const { meetingId } = seedMeeting({ creator: 1, state: "waiting_for_approval" });
    const ctxId = randomUUID();
    fake.context.set(ctxId, { id: ctxId, meeting_id: meetingId });
    const res = await request(app)
      .post(`/api/meetings/${meetingId}/turn/approve`)
      .send({ context_entry_id: ctxId, approved: false });
    expect(res.status).toBe(200);
    expect(fake.meetings.get(meetingId)!.state).toBe("aborted");
    await new Promise((r) => setImmediate(r));
    expect(recording.events[0].payload.reason).toBe("rejected");
  });
});

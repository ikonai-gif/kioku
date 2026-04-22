/**
 * Unit tests for server/lib/meeting-reaper.ts — W9 Item 2 (§2d).
 *
 * The reaper runs two sweeps in sequence:
 *   1. Stuck turns: UPDATE turn_records WHERE state='running' AND started_at < now() - interval
 *      RETURNING id, meeting_id  →  UPDATE meetings WHERE current_turn_id = ANY($2)
 *   2. Stale approvals: UPDATE meetings WHERE state='waiting_for_approval'
 *      AND (metadata->>'waiting_since')::timestamptz < now() - interval
 *
 * We stand up a minimal FakePool that recognises the reaper's two SQL shapes
 * and applies them in-memory. Tests then assert:
 *   - stuck turn_records flipped to 'failed' with `error='turn_timeout'`
 *   - owning meeting flipped to 'aborted' with abort_reason='turn_timeout'
 *   - stale waiting_for_approval meetings aborted with 'approval_timeout'
 *   - events emitted via the injected RecordingMeetingEventBus
 *   - gating on MEETING_ROOM_ENABLED (startMeetingReaper returns a no-op handle)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";

vi.mock("../logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runReaperSweep, startMeetingReaper } from "../lib/meeting-reaper";
import { RecordingMeetingEventBus } from "../lib/meeting-event-bus";

// ── FakePool ─────────────────────────────────────────────────────────────────

interface Row { [k: string]: any }
interface World {
  meetings: Row[];
  turn_records: Row[];
}

function newWorld(): World {
  return { meetings: [], turn_records: [] };
}

function wrap(rows: Row[]) {
  return { rows, rowCount: rows.length };
}

/**
 * Extract the integer seconds from an inline `interval 'N seconds'` literal.
 * The reaper builds this via string interpolation (safe — only its own int).
 */
function parseIntervalSeconds(sql: string): number {
  const m = sql.match(/interval\s+'(\d+)\s+seconds'/);
  return m ? Number(m[1]) : 0;
}

class FakeClient {
  private inTx = false;
  private buffered: Array<() => void> = [];
  private released = false;
  constructor(private readonly world: World) {}

  async query(text: string, params: any[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    const sql = text.trim();
    if (sql === "BEGIN") { this.inTx = true; this.buffered = []; return wrap([]); }
    if (sql === "COMMIT") {
      this.inTx = false;
      for (const fn of this.buffered) fn();
      this.buffered = [];
      return wrap([]);
    }
    if (sql === "ROLLBACK") {
      this.inTx = false;
      this.buffered = [];
      return wrap([]);
    }

    // ── 1a. Stuck turns UPDATE ──
    if (
      sql.startsWith("UPDATE turn_records") &&
      sql.includes("SET state = 'failed'") &&
      sql.includes("started_at <")
    ) {
      const timeoutSeconds = parseIntervalSeconds(sql);
      const cutoff = Date.now() - timeoutSeconds * 1000;
      const [errText] = params as [string];
      const matched = this.world.turn_records.filter(
        (r) => r.state === "running" && r.started_at.getTime() < cutoff,
      );
      // Emulate UPDATE ... RETURNING: the returned rows reflect the rows
      // the UPDATE matched (their id/meeting_id survive the SET), and we
      // apply the mutation. Inside a tx we stage the mutation but still
      // return the RETURNING rows synchronously (real PG does too).
      const out: Row[] = matched.map((r) => ({ turn_id: r.id, meeting_id: r.meeting_id }));
      const apply = () => {
        for (const r of matched) {
          r.state = "failed";
          r.error = errText;
          r.completed_at = new Date();
        }
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap(out);
    }

    // ── 1b. Abort owning meetings ──
    if (
      sql.startsWith("UPDATE meetings") &&
      sql.includes("SET state = 'aborted'") &&
      sql.includes("current_turn_id = ANY($2::uuid[])")
    ) {
      const [reason, turnIds] = params as [string, string[]];
      const matched = this.world.meetings.filter(
        (m) => m.state === "turn_in_progress" && turnIds.includes(m.current_turn_id),
      );
      const out: Row[] = matched.map((m) => ({ id: m.id }));
      const apply = () => {
        for (const m of matched) {
          m.state = "aborted";
          m.current_turn_id = null;
          m.metadata = {
            ...(m.metadata ?? {}),
            abort_reason: reason,
            aborted_at: new Date().toISOString(),
          };
        }
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap(out);
    }

    // ── 2. Stale approvals ──
    if (
      sql.startsWith("UPDATE meetings") &&
      sql.includes("SET state = 'aborted'") &&
      sql.includes("waiting_since")
    ) {
      const timeoutSeconds = parseIntervalSeconds(sql);
      const cutoff = Date.now() - timeoutSeconds * 1000;
      const [reason] = params as [string];
      const matched = this.world.meetings.filter((m) => {
        if (m.state !== "waiting_for_approval") return false;
        const since = m.metadata?.waiting_since;
        if (!since) return false;
        return new Date(since).getTime() < cutoff;
      });
      const out: Row[] = matched.map((m) => ({ id: m.id }));
      const apply = () => {
        for (const m of matched) {
          m.state = "aborted";
          m.current_turn_id = null;
          m.metadata = {
            ...(m.metadata ?? {}),
            abort_reason: reason,
            aborted_at: new Date().toISOString(),
          };
        }
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap(out);
    }

    throw new Error(`FakeClient[reaper]: unhandled SQL: ${sql.slice(0, 160)}`);
  }

  release(): void {
    this.released = true;
  }
}

class FakePool {
  constructor(private readonly world: World) {}
  async connect(): Promise<FakeClient> {
    return new FakeClient(this.world);
  }
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedStuckTurn(world: World, ageMs: number): { meetingId: string; turnId: string } {
  const meetingId = randomUUID();
  const turnId = randomUUID();
  world.meetings.push({
    id: meetingId,
    state: "turn_in_progress",
    current_turn_id: turnId,
    next_participant_id: null,
    metadata: {},
  });
  world.turn_records.push({
    id: turnId,
    meeting_id: meetingId,
    participant_id: randomUUID(),
    sequence_fence: 0,
    state: "running",
    started_at: new Date(Date.now() - ageMs),
    completed_at: null,
    error: null,
  });
  return { meetingId, turnId };
}

function seedStaleApproval(world: World, ageMs: number): { meetingId: string } {
  const meetingId = randomUUID();
  world.meetings.push({
    id: meetingId,
    state: "waiting_for_approval",
    current_turn_id: null,
    next_participant_id: null,
    metadata: { waiting_since: new Date(Date.now() - ageMs).toISOString() },
  });
  return { meetingId };
}

// ── Reset env between tests ──────────────────────────────────────────────────

const savedEnv = { MEETING_ROOM_ENABLED: process.env.MEETING_ROOM_ENABLED };
beforeEach(() => {
  process.env.MEETING_ROOM_ENABLED = "true";
});
afterEach(() => {
  process.env.MEETING_ROOM_ENABLED = savedEnv.MEETING_ROOM_ENABLED;
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Stuck turn > threshold → aborted
// ═════════════════════════════════════════════════════════════════════════════

describe("reaper — stuck turns", () => {
  it("turn running > turnTimeoutMs → turn_records 'failed', meeting 'aborted', event emitted", async () => {
    const world = newWorld();
    const { meetingId, turnId } = seedStuckTurn(world, 200_000); // 200s old, threshold 120s
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    expect(stats.stuckTurnsAborted).toBe(1);
    expect(world.turn_records[0].state).toBe("failed");
    expect(world.turn_records[0].error).toBe("turn_timeout");
    expect(world.meetings[0].state).toBe("aborted");
    expect(world.meetings[0].metadata.abort_reason).toBe("turn_timeout");
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0]).toMatchObject({
      event: "meeting.state.changed",
      payload: { meetingId, state: "aborted", reason: "turn_timeout", previousState: "turn_in_progress" },
    });
    // turnId present in turn_records via `error='turn_timeout'` but not echoed
    // to the caller — that's fine. Just assert the row identity survives.
    expect(world.turn_records[0].id).toBe(turnId);
  });

  it("turn running < threshold → untouched", async () => {
    const world = newWorld();
    seedStuckTurn(world, 5_000); // 5s old, nowhere near 120s
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    expect(stats.stuckTurnsAborted).toBe(0);
    expect(world.turn_records[0].state).toBe("running");
    expect(world.meetings[0].state).toBe("turn_in_progress");
    expect(bus.events).toHaveLength(0);
  });

  it("multiple stuck turns across different meetings — each aborted once", async () => {
    const world = newWorld();
    seedStuckTurn(world, 200_000);
    seedStuckTurn(world, 300_000);
    seedStuckTurn(world, 5_000); // fresh — survives
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    expect(stats.stuckTurnsAborted).toBe(2);
    expect(world.meetings.filter((m) => m.state === "aborted")).toHaveLength(2);
    expect(world.meetings.filter((m) => m.state === "turn_in_progress")).toHaveLength(1);
    expect(bus.events).toHaveLength(2);
  });

  it("custom turnTimeoutMs threshold honoured", async () => {
    const world = newWorld();
    seedStuckTurn(world, 10_000); // 10s old
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();
    // threshold=5s → should abort
    const stats = await runReaperSweep({
      pool: pool as any,
      eventBus: bus,
      turnTimeoutMs: 5_000,
    });
    expect(stats.stuckTurnsAborted).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Stale approvals > threshold → aborted
// ═════════════════════════════════════════════════════════════════════════════

describe("reaper — stale approvals", () => {
  it("waiting_for_approval > approvalTimeoutMs → aborted with 'approval_timeout'", async () => {
    const world = newWorld();
    const { meetingId } = seedStaleApproval(world, 25 * 60 * 60 * 1000); // 25h > 24h
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    expect(stats.staleApprovalsAborted).toBe(1);
    const m = world.meetings.find((r) => r.id === meetingId)!;
    expect(m.state).toBe("aborted");
    expect(m.metadata.abort_reason).toBe("approval_timeout");
    expect(bus.events).toHaveLength(1);
    expect(bus.events[0].event).toBe("meeting.state.changed");
    expect(bus.events[0].payload).toMatchObject({
      meetingId,
      state: "aborted",
      reason: "approval_timeout",
      previousState: "waiting_for_approval",
    });
  });

  it("waiting_for_approval < threshold → untouched", async () => {
    const world = newWorld();
    seedStaleApproval(world, 60_000); // 1min, way under 24h
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    expect(stats.staleApprovalsAborted).toBe(0);
    expect(world.meetings[0].state).toBe("waiting_for_approval");
  });

  it("custom approvalTimeoutMs threshold honoured", async () => {
    const world = newWorld();
    seedStaleApproval(world, 120_000); // 2min
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();
    const stats = await runReaperSweep({
      pool: pool as any,
      eventBus: bus,
      approvalTimeoutMs: 60_000, // 1min threshold
    });
    expect(stats.staleApprovalsAborted).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Combined sweep — both buckets in one pass
// ═════════════════════════════════════════════════════════════════════════════

describe("reaper — combined sweep", () => {
  it("one stuck turn + one stale approval → both aborted, two events", async () => {
    const world = newWorld();
    seedStuckTurn(world, 200_000);
    seedStaleApproval(world, 25 * 60 * 60 * 1000);
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    expect(stats.stuckTurnsAborted).toBe(1);
    expect(stats.staleApprovalsAborted).toBe(1);
    expect(bus.events).toHaveLength(2);
    // Stuck-turn event fires first (ordering matches reaper's two-step pass).
    expect(bus.events[0].payload.previousState).toBe("turn_in_progress");
    expect(bus.events[1].payload.previousState).toBe("waiting_for_approval");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. startMeetingReaper gating on MEETING_ROOM_ENABLED
// ═════════════════════════════════════════════════════════════════════════════

describe("reaper — startMeetingReaper flag gate", () => {
  it("MEETING_ROOM_ENABLED != 'true' → returns no-op handle that does NO sweeps", async () => {
    process.env.MEETING_ROOM_ENABLED = "false";
    const world = newWorld();
    seedStuckTurn(world, 600_000);
    const pool = new FakePool(world);

    const handle = startMeetingReaper({ pool: pool as any, intervalMs: 5 });
    try {
      const stats = await handle.sweepOnce();
      expect(stats).toEqual({ stuckTurnsAborted: 0, staleApprovalsAborted: 0 });
      // World untouched — flag-off reaper must not issue any UPDATEs.
      expect(world.turn_records[0].state).toBe("running");
      expect(world.meetings[0].state).toBe("turn_in_progress");
    } finally {
      handle.stop();
    }
  });

  it("MEETING_ROOM_ENABLED='true' → sweepOnce actually sweeps", async () => {
    process.env.MEETING_ROOM_ENABLED = "true";
    const world = newWorld();
    seedStuckTurn(world, 600_000);
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    // Use a very long interval so the setInterval tick never fires during the test.
    const handle = startMeetingReaper({
      pool: pool as any,
      eventBus: bus,
      intervalMs: 60_000,
    });
    try {
      const stats = await handle.sweepOnce();
      expect(stats.stuckTurnsAborted).toBe(1);
      expect(world.meetings[0].state).toBe("aborted");
    } finally {
      handle.stop();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Meeting already aborted between sweep select and abort → no double-abort
//    (regression guard for the race where the meeting is aborted by some
//    other path before the reaper's UPDATE. The WHERE state='turn_in_progress'
//    clause filters it out.)
// ═════════════════════════════════════════════════════════════════════════════

describe("reaper — race with external abort", () => {
  it("meeting already aborted before reaper fires → stuck turn flips but meeting UPDATE is a no-op", async () => {
    const world = newWorld();
    const { meetingId } = seedStuckTurn(world, 200_000);
    // Pretend some other code already aborted this meeting.
    world.meetings[0].state = "aborted";
    world.meetings[0].current_turn_id = null;
    const pool = new FakePool(world);
    const bus = new RecordingMeetingEventBus();

    const stats = await runReaperSweep({ pool: pool as any, eventBus: bus });
    // turn_records still flips (its predicate doesn't care about meeting state).
    expect(world.turn_records[0].state).toBe("failed");
    // But the meetings UPDATE skips — stats reflect 0 meetings aborted.
    expect(stats.stuckTurnsAborted).toBe(0);
    expect(bus.events).toHaveLength(0);
    expect(world.meetings.find((m) => m.id === meetingId)!.state).toBe("aborted");
  });
});

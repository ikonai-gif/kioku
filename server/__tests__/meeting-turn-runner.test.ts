/**
 * Unit tests for server/lib/meeting-turn-runner.ts — W9 Item 2.
 *
 * Runner surface (see meeting-turn-runner.ts):
 *   runTurn(pool, { meetingId, participantId?, idempotencyKey?, llm, eventBus? })
 *
 * Unlike MCM (Item 1) which only reads, the runner does TRANSACTIONAL writes
 * across two separate PoolClients (T1 reserve, T2 commit, T2-fail abort) and
 * relies on `FOR UPDATE` to serialise concurrent hits. A minimal FakePool
 * models this:
 *   - Each `connect()` returns a fresh FakeClient with its own write buffer.
 *   - BEGIN opens the tx; queries writing to `meetings` / `turn_records` /
 *     `meeting_context` stage into the client's buffer. COMMIT flushes; ROLLBACK
 *     discards.
 *   - `SELECT … FOR UPDATE` on `meetings` acquires a per-meeting async lock.
 *     A second connect()→BEGIN→SELECT FOR UPDATE on the same meeting row
 *     blocks until the holder runs COMMIT/ROLLBACK. This is exactly the
 *     concurrency primitive Postgres gives us and it's what the runner's
 *     Bro2 SF1 concurrency test exercises.
 *   - SQL matching is SQL-shape based (distinctive landmarks in the text),
 *     NOT a full parser — same strategy as MCM's FakeDbExecutor.
 *
 * Idempotency and deliberation are module-mocked via `vi.mock` so tests can
 * drive the Redis side deterministically and stub out the partner-tools
 * registry without dragging in the full client.
 *
 * Plan v2 §Item 2 calls for ~20 tests. This file:
 *   1.  Happy path — two agents × three rounds (6 turns, alternating participants)
 *   2.  M1 concurrent same-fence → one wins, the other 409 state_mismatch
 *   3.  M1 sequential retry with same Idempotency-Key → cached replay, no new T1
 *   4.  M2 LLM tool set contains zero memory-write tools
 *   5.  LLM call error → meeting aborted, no meeting_context row written
 *   6.  Breaker open (CircuitOpenError) → TurnBreakerOpenError, meeting aborted
 *   7.  LLM timeout > LLM_TIMEOUT_MS → TurnTimeoutError, meeting aborted
 *   8.  F3 wrong participant_id (mismatches next_participant_id) → 409 out_of_order
 *   9.  Approve-mode speaker → waiting_for_approval, next_participant pinned to self
 *  10.  Profile missing → aborted before LLM
 *  11.  Round-robin across 3 participants — full cycle returns to starter
 *  12.  Round-robin skips left participants
 *  13.  Idempotency fence: private rows by OTHER agents legitimately bust replay
 *       (Bro2 SF2) — fresh T1, not cache hit
 *  14.  State-transition table: rejects pending / completed / aborted / turn_in_progress
 *  15.  Turn cap (MAX_TURNS_PER_MEETING=20) → turn_cap_exceeded
 *  16.  T1 rollback on meeting-not-found, no side effects
 *  17.  Already-running (current_turn_id not null) → already_running
 *  18.  Event bus: emits meeting.turn.completed AFTER commit (not inside tx)
 *  19.  Event bus: emits meeting.state.changed on abort path
 *  20.  Idempotency key provided but NEW → stores result after commit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "crypto";

// ── Module mocks (must come before target imports) ───────────────────────────

// Mock the partner tools registry so we don't drag in deliberation.ts (which
// imports the whole LLM surface). The runner calls
// `mod.getPartnerToolsForAgent({ name })`; we return a fixed tool list that
// includes one memory-write tool to verify it's filtered.
vi.mock("../deliberation", () => ({
  getPartnerToolsForAgent: vi.fn(() => [
    { name: "recall", description: "read memories", input_schema: { type: "object", properties: {} } },
    { name: "remember", description: "write memory (should be stripped)", input_schema: { type: "object", properties: {} } },
    { name: "searchWeb", description: "search the web", input_schema: { type: "object", properties: {} } },
  ]),
}));

// Mock idempotency — defaults below route to an in-memory store. Individual
// tests override `mockCheckIdempotency` / `mockStoreIdempotencyResult`.
const idemStore = new Map<string, { status: "in_progress" | "done"; result?: unknown }>();
const mockCheckIdempotency = vi.fn(async (key: string) => {
  const entry = idemStore.get(key);
  if (!entry) {
    idemStore.set(key, { status: "in_progress" });
    return { status: "new" as const };
  }
  if (entry.status === "done") return { status: "done" as const, result: entry.result };
  return { status: "in_progress" as const };
});
const mockStoreIdempotencyResult = vi.fn(async (key: string, result: unknown) => {
  idemStore.set(key, { status: "done", result });
});
const mockMakeIdempotencyKey = vi.fn((scope: string, payload: unknown) => {
  // Hash payload contents (not length) so distinct client keys map to distinct cache keys.
  const json = JSON.stringify(payload);
  let h = 0;
  for (let i = 0; i < json.length; i++) h = ((h * 31) + json.charCodeAt(i)) | 0;
  return `idem:${scope}:${(h >>> 0).toString(16).padStart(16, "0")}`;
});
vi.mock("../idempotency", () => ({
  makeIdempotencyKey: (scope: string, payload: unknown) => mockMakeIdempotencyKey(scope, payload),
  checkIdempotency: (key: string) => mockCheckIdempotency(key),
  storeIdempotencyResult: (key: string, result: unknown) => mockStoreIdempotencyResult(key, result),
  DEFAULT_TTL_LONG: 86400,
  DEFAULT_PENDING_TTL: 60,
}));

// Silence logger noise during negative-path tests.
vi.mock("../logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Target imports ───────────────────────────────────────────────────────────

import {
  runTurn,
  MAX_TURNS_PER_MEETING,
  LLM_TIMEOUT_MS,
  TurnStateMismatchError,
  TurnBreakerOpenError,
  TurnTimeoutError,
  type LlmCaller,
  type MeetingStateDb,
} from "../lib/meeting-turn-runner";
import { RecordingMeetingEventBus } from "../lib/meeting-event-bus";
import { CircuitOpenError } from "../lib/circuit-breaker";

// ── FakePool / FakeClient ────────────────────────────────────────────────────

/**
 * In-memory shape of the subset of the KIOKU schema the runner touches.
 * FakePool mutates this on COMMIT.
 */
interface Row {
  [k: string]: any;
}
interface World {
  meetings: Row[];
  meeting_participants: Row[];
  meeting_context: Row[];
  turn_records: Row[];
  agents: Row[];
  meeting_participant_profiles: Row[];
}

function newWorld(): World {
  return {
    meetings: [],
    meeting_participants: [],
    meeting_context: [],
    turn_records: [],
    agents: [],
    meeting_participant_profiles: [],
  };
}

/**
 * Per-meeting async lock. `SELECT ... FOR UPDATE` on meetings with this id
 * must wait until the current holder releases (COMMIT or ROLLBACK).
 */
class MeetingLock {
  private chain = new Map<string, Promise<void>>();
  async acquire(meetingId: string): Promise<() => void> {
    const prior = this.chain.get(meetingId) ?? Promise.resolve();
    let release!: () => void;
    const p = new Promise<void>((resolve) => (release = resolve));
    this.chain.set(meetingId, prior.then(() => p));
    await prior;
    return release;
  }
}

interface FakePoolOptions {
  world: World;
  lock: MeetingLock;
}

class FakeClient {
  private inTx = false;
  private lockRelease: (() => void) | null = null;
  private lockedMeetingId: string | null = null;
  private buffered: Array<() => void> = [];
  private released = false;
  constructor(private readonly opts: FakePoolOptions) {}

  async query(text: string, params: any[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    const sql = text.trim();

    if (sql === "BEGIN") {
      if (this.inTx) throw new Error("nested BEGIN not supported by FakeClient");
      this.inTx = true;
      this.buffered = [];
      return wrap([]);
    }
    if (sql === "COMMIT") {
      this.inTx = false;
      for (const fn of this.buffered) fn();
      this.buffered = [];
      if (this.lockRelease) {
        this.lockRelease();
        this.lockRelease = null;
        this.lockedMeetingId = null;
      }
      return wrap([]);
    }
    if (sql === "ROLLBACK") {
      this.inTx = false;
      this.buffered = [];
      if (this.lockRelease) {
        this.lockRelease();
        this.lockRelease = null;
        this.lockedMeetingId = null;
      }
      return wrap([]);
    }

    // ── meetings FOR UPDATE (T1 + T2) ──
    if (sql.startsWith("SELECT") && sql.includes("FROM meetings") && sql.includes("FOR UPDATE")) {
      const meetingId = params[0] as string;
      if (this.lockedMeetingId !== meetingId) {
        this.lockRelease = await this.opts.lock.acquire(meetingId);
        this.lockedMeetingId = meetingId;
      }
      const m = this.opts.world.meetings.find((r) => r.id === meetingId);
      return wrap(m ? [m] : []);
    }

    // ── turn_records cap COUNT ──
    if (
      sql.startsWith("SELECT COUNT(*)") &&
      sql.includes("FROM turn_records") &&
      sql.includes("state IN ('completed','failed')")
    ) {
      const meetingId = params[0] as string;
      const n = this.opts.world.turn_records.filter(
        (r) => r.meeting_id === meetingId && (r.state === "completed" || r.state === "failed"),
      ).length;
      return wrap([{ n }]);
    }

    // ── sequence fence (T1) + next seq (T2) ──
    if (
      sql.startsWith("SELECT COALESCE(MAX(sequence_number), 0)") &&
      sql.includes("FROM meeting_context") &&
      !sql.includes("+ 1")
    ) {
      const meetingId = params[0] as string;
      const fence = this.opts.world.meeting_context
        .filter((r) => r.meeting_id === meetingId)
        .reduce((m, r) => Math.max(m, r.sequence_number), 0);
      return wrap([{ fence }]);
    }
    if (
      sql.startsWith("SELECT COALESCE(MAX(sequence_number), 0)") &&
      sql.includes("+ 1 AS next_seq") &&
      sql.includes("FROM meeting_context")
    ) {
      const meetingId = params[0] as string;
      const next = this.opts.world.meeting_context
        .filter((r) => r.meeting_id === meetingId)
        .reduce((m, r) => Math.max(m, r.sequence_number), 0) + 1;
      return wrap([{ next_seq: next }]);
    }

    // ── INSERT INTO turn_records (T1) ──
    if (sql.startsWith("INSERT INTO turn_records")) {
      const [id, meetingId, participantId, sequenceFence] = params as [
        string, string, string, number,
      ];
      const row = {
        id,
        meeting_id: meetingId,
        participant_id: participantId,
        sequence_fence: sequenceFence,
        state: "running",
        started_at: new Date(),
        completed_at: null as Date | null,
        error: null as string | null,
      };
      if (this.inTx) this.buffered.push(() => this.opts.world.turn_records.push(row));
      else this.opts.world.turn_records.push(row);
      return wrap([]);
    }

    // ── UPDATE meetings SET state='turn_in_progress' (T1) ──
    if (
      sql.startsWith("UPDATE meetings") &&
      sql.includes("SET state = 'turn_in_progress'") &&
      sql.includes("current_turn_id = $1")
    ) {
      const [turnId, meetingId] = params as [string, string];
      const m = this.opts.world.meetings.find((r) => r.id === meetingId);
      if (!m) return wrap([]);
      if (this.inTx) {
        this.buffered.push(() => {
          m.state = "turn_in_progress";
          m.current_turn_id = turnId;
        });
      } else {
        m.state = "turn_in_progress";
        m.current_turn_id = turnId;
      }
      return wrap([]);
    }

    // ── INSERT INTO meeting_context (T2) ──
    if (sql.startsWith("INSERT INTO meeting_context")) {
      const [meetingId, seq, content, agentId, visibility, scopeJson] = params as [
        string, number, string, number, string, string,
      ];
      const id = randomUUID();
      const row = {
        id,
        meeting_id: meetingId,
        sequence_number: seq,
        content,
        author_agent_id: agentId,
        visibility,
        scope_agent_ids: JSON.parse(scopeJson) as number[],
        created_at: new Date(),
      };
      if (this.inTx) this.buffered.push(() => this.opts.world.meeting_context.push(row));
      else this.opts.world.meeting_context.push(row);
      return wrap([{ id }]);
    }

    // ── UPDATE turn_records SET state='completed' (T2) ──
    if (
      sql.startsWith("UPDATE turn_records") &&
      sql.includes("state = 'completed'") &&
      sql.includes("completed_at = now()") &&
      sql.includes("WHERE id = $1")
    ) {
      const [turnId] = params as [string];
      const r = this.opts.world.turn_records.find((x) => x.id === turnId);
      if (!r) return wrap([]);
      const apply = () => {
        r.state = "completed";
        r.completed_at = new Date();
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap([]);
    }

    // ── UPDATE turn_records SET state='failed' (t2Fail) ──
    if (
      sql.startsWith("UPDATE turn_records") &&
      sql.includes("state = 'failed'") &&
      sql.includes("error = $1")
    ) {
      const [errText, turnId] = params as [string, string];
      const r = this.opts.world.turn_records.find((x) => x.id === turnId);
      if (!r) return wrap([]);
      const apply = () => {
        r.state = "failed";
        r.error = errText;
        r.completed_at = new Date();
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap([]);
    }

    // ── pickNextParticipant (T2) — round-robin CTE ──
    if (
      sql.includes("WITH active AS") &&
      sql.includes("FROM meeting_participants") &&
      sql.includes("ORDER BY joined_at ASC")
    ) {
      const [meetingId, currentParticipantId] = params as [string, string];
      const active = this.opts.world.meeting_participants
        .filter((p) => p.meeting_id === meetingId && p.left_at === null)
        .slice()
        .sort((a, b) => {
          const t = (a.joined_at?.getTime?.() ?? 0) - (b.joined_at?.getTime?.() ?? 0);
          if (t !== 0) return t;
          return (a.id as string).localeCompare(b.id as string);
        });
      if (active.length === 0) return wrap([]);
      const idx = active.findIndex((p) => p.id === currentParticipantId);
      if (idx === -1) return wrap([]);
      const next = active[(idx + 1) % active.length];
      return wrap([{ id: next.id }]);
    }

    // ── currentModeRequiresApproval ──
    if (
      sql.startsWith("SELECT participation_mode FROM meeting_participants") &&
      sql.includes("WHERE id = $1")
    ) {
      const [participantId] = params as [string];
      const p = this.opts.world.meeting_participants.find((r) => r.id === participantId);
      return wrap(p ? [{ participation_mode: p.participation_mode ?? "autonomous" }] : []);
    }

    // ── UPDATE meetings SET state = $1 … (T2 final) ──
    if (
      sql.startsWith("UPDATE meetings") &&
      sql.includes("SET state = $1") &&
      sql.includes("current_turn_id = NULL") &&
      sql.includes("next_participant_id = $2")
    ) {
      const [newState, nextPid, meetingId] = params as [string, string | null, string];
      const m = this.opts.world.meetings.find((r) => r.id === meetingId);
      if (!m) return wrap([]);
      const apply = () => {
        m.state = newState;
        m.current_turn_id = null;
        m.next_participant_id = nextPid;
        if (newState === "waiting_for_approval") {
          m.metadata = { ...(m.metadata ?? {}), waiting_since: new Date().toISOString() };
        }
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap([]);
    }

    // ── UPDATE meetings SET state='aborted' (t2Fail) ──
    if (
      sql.startsWith("UPDATE meetings") &&
      sql.includes("SET state = 'aborted'") &&
      sql.includes("current_turn_id = $3")
    ) {
      const [reason, meetingId, turnId] = params as [string, string, string];
      const m = this.opts.world.meetings.find((r) => r.id === meetingId);
      if (!m || m.current_turn_id !== turnId) return wrap([]);
      const apply = () => {
        m.state = "aborted";
        m.current_turn_id = null;
        m.metadata = {
          ...(m.metadata ?? {}),
          abort_reason: reason,
          aborted_at: new Date().toISOString(),
        };
      };
      if (this.inTx) this.buffered.push(apply);
      else apply();
      return wrap([]);
    }

    // ── MCM big join (inside buildTurnInput) ──
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM meetings m") &&
      sql.includes("LEFT JOIN meeting_participants mp") &&
      sql.includes("LEFT JOIN agents a") &&
      sql.includes("LEFT JOIN meeting_participant_profiles mpp")
    ) {
      const [meetingId, participantId] = params as [string, string];
      const meeting = this.opts.world.meetings.find((m) => m.id === meetingId);
      if (!meeting) return wrap([]);
      const participant = this.opts.world.meeting_participants.find(
        (p) => p.meeting_id === meetingId && p.id === participantId,
      );
      const agent = participant
        ? this.opts.world.agents.find((a) => a.id === participant.agent_id)
        : undefined;
      const profile = participant
        ? this.opts.world.meeting_participant_profiles.find(
            (pr) => pr.meeting_id === meetingId && pr.agent_id === participant.agent_id,
          )
        : undefined;
      return wrap([
        {
          meeting_id: meeting.id,
          meeting_state: meeting.state,
          participant_id: participant?.id ?? null,
          agent_id: participant?.agent_id ?? null,
          owner_user_id: participant?.owner_user_id ?? null,
          left_at: participant?.left_at ?? null,
          agent_name: agent?.name ?? null,
          agent_description: agent?.description ?? null,
          agent_llm_model: agent?.llm_model ?? null,
          autonomy_level: profile?.autonomy_level ?? null,
          allowed_topics: profile?.allowed_topics ?? null,
          blocked_topics: profile?.blocked_topics ?? null,
          memory_scope: profile?.memory_scope ?? null,
          carry_over_memory: profile?.carry_over_memory ?? null,
        },
      ]);
    }

    // ── MCM visible-context scan ──
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM meeting_context") &&
      sql.includes("scope_agent_ids") &&
      sql.includes("LIMIT")
    ) {
      const [meetingId, agentId, limit] = params as [string, number, number];
      const visible = this.opts.world.meeting_context
        .filter((r) => r.meeting_id === meetingId)
        .filter((r) => {
          switch (r.visibility) {
            case "all": return true;
            case "owner": return false;
            case "scoped": return (r.scope_agent_ids as number[]).includes(agentId);
            case "private":
              return r.author_agent_id === agentId ||
                     (r.scope_agent_ids as number[]).includes(agentId);
            default: return false;
          }
        })
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .slice(0, limit);
      return wrap(visible);
    }

    throw new Error(
      `FakeClient: unhandled SQL (first 160 chars): ${sql.slice(0, 160)}`,
    );
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.lockRelease) {
      this.lockRelease();
      this.lockRelease = null;
    }
  }
}

class FakePool {
  constructor(public readonly opts: FakePoolOptions) {}
  async connect(): Promise<FakeClient> {
    return new FakeClient(this.opts);
  }
}

function wrap(rows: Row[]): { rows: Row[]; rowCount: number } {
  return { rows, rowCount: rows.length };
}

// ── Seed builders ────────────────────────────────────────────────────────────

interface SeedIds {
  meetingId: string;
  p1: string; // participant 1 (agent 101 — Luca)
  p2: string; // participant 2 (agent 102 — Bro2)
  p3?: string;
}

function seedTwoAgentMeeting(world: World): SeedIds {
  const meetingId = "m-" + randomUUID();
  const p1 = "p1-" + randomUUID();
  const p2 = "p2-" + randomUUID();
  world.agents.push(
    { id: 101, name: "Luca", description: "KIOKU companion", llm_model: "claude-sonnet-4-6" },
    { id: 102, name: "Bro2", description: "reviewer", llm_model: "claude-sonnet-4-6" },
  );
  world.meetings.push({
    id: meetingId,
    state: "active" as MeetingStateDb,
    next_participant_id: p1,
    current_turn_id: null,
    metadata: {},
  });
  const now = new Date();
  world.meeting_participants.push(
    { id: p1, meeting_id: meetingId, agent_id: 101, owner_user_id: 10, left_at: null,
      joined_at: new Date(now.getTime() - 2000), participation_mode: "autonomous" },
    { id: p2, meeting_id: meetingId, agent_id: 102, owner_user_id: 10, left_at: null,
      joined_at: new Date(now.getTime() - 1000), participation_mode: "autonomous" },
  );
  for (const agentId of [101, 102]) {
    world.meeting_participant_profiles.push({
      meeting_id: meetingId,
      agent_id: agentId,
      autonomy_level: "propose",
      allowed_topics: ["design"],
      blocked_topics: [],
      memory_scope: {},
      carry_over_memory: false,
    });
  }
  return { meetingId, p1, p2 };
}

function seedThreeAgentMeeting(world: World): SeedIds {
  const ids = seedTwoAgentMeeting(world);
  const p3 = "p3-" + randomUUID();
  world.agents.push({ id: 103, name: "Eva", description: "assistant", llm_model: null });
  world.meeting_participants.push({
    id: p3,
    meeting_id: ids.meetingId,
    agent_id: 103,
    owner_user_id: 10,
    left_at: null,
    joined_at: new Date(Date.now()),
    participation_mode: "autonomous",
  });
  world.meeting_participant_profiles.push({
    meeting_id: ids.meetingId,
    agent_id: 103,
    autonomy_level: "propose",
    allowed_topics: [],
    blocked_topics: [],
    memory_scope: {},
    carry_over_memory: false,
  });
  return { ...ids, p3 };
}

function makeLlm(content = "hello", visibility: "all" | "scoped" | "private" = "all"): LlmCaller {
  return vi.fn(async () => ({ content, visibility }));
}

// ── Fixture reset ────────────────────────────────────────────────────────────

beforeEach(() => {
  idemStore.clear();
  mockCheckIdempotency.mockClear();
  mockStoreIdempotencyResult.mockClear();
  mockMakeIdempotencyKey.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Happy path — two agents × three rounds
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — happy path", () => {
  it("two agents × three rounds: 6 turns alternate and advance state each step", async () => {
    const world = newWorld();
    const { meetingId, p1, p2 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const llm = vi.fn(async () => ({ content: "ok", visibility: "all" as const }));
    const bus = new RecordingMeetingEventBus();

    let expected = p1;
    for (let i = 0; i < 6; i++) {
      const result = await runTurn(pool as any, {
        meetingId,
        participantId: expected,
        llm,
        eventBus: bus,
      });
      expect(result.sequenceNumber).toBe(i + 1);
      expect(result.newState).toBe("waiting_for_turn");
      expect(result.participantId).toBe(expected);
      expect(result.replayed).toBe(false);
      expected = expected === p1 ? p2 : p1;
    }
    expect(world.meeting_context.length).toBe(6);
    expect(world.turn_records.every((r) => r.state === "completed")).toBe(true);
    expect(bus.events.length).toBe(6);
    expect(bus.events.every((e) => e.event === "meeting.turn.completed")).toBe(true);
    // Final meeting state: turn_records cleared, state reset to waiting_for_turn
    const m = world.meetings[0];
    expect(m.current_turn_id).toBeNull();
    expect(m.next_participant_id).toBe(expected); // the one who would go next
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. M1 concurrent same-fence → one wins, the other 409 state_mismatch
//    (Bro2 SF1: NOT an idempotency cache hit — both requests fire T1, the FOR
//     UPDATE serialises them, and the loser sees state=turn_in_progress.)
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — concurrency (M1)", () => {
  it("two concurrent turns on the same fence: first wins, second → 409 state_mismatch", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    let llmResolves: Array<() => void> = [];
    const llm: LlmCaller = vi.fn(
      () =>
        new Promise((resolve) => {
          llmResolves.push(() =>
            resolve({ content: "first-content", visibility: "all" as const }),
          );
        }),
    );

    // Attach catch handlers synchronously so an async rejection of r2 doesn't
    // trip the unhandledRejection hook before we `await` below.
    const r1 = runTurn(pool as any, { meetingId, participantId: p1, llm });
    const r2 = runTurn(pool as any, { meetingId, participantId: p1, llm });
    const r2Settled = r2.then(
      (v) => ({ ok: true as const, value: v }),
      (e) => ({ ok: false as const, error: e }),
    );
    r1.catch(() => undefined); // suppress any late unhandled (shouldn't happen)

    // Let both T1 rounds resolve. The second hits the lock; by the time it
    // gets in, the first has flipped state to turn_in_progress and committed,
    // so the second sees state_mismatch BEFORE any LLM call happens.
    await new Promise((r) => setTimeout(r, 20));

    // Complete the first LLM call so r1 can T2-commit.
    llmResolves[0]?.();
    await expect(r1).resolves.toMatchObject({ sequenceNumber: 1, newState: "waiting_for_turn" });
    const r2Result = await r2Settled;
    expect(r2Result.ok).toBe(false);
    if (!r2Result.ok) {
      expect(r2Result.error).toMatchObject({
        name: "TurnStateMismatchError",
        code: "state_mismatch",
      });
    }
    // Only one turn_records row ended up running/completed.
    expect(world.turn_records.filter((r) => r.state === "completed").length).toBe(1);
    expect(world.meeting_context.length).toBe(1);
    // LLM was only called once (the loser never made it past T1).
    expect((llm as any).mock.calls.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Idempotency sequential retry — same key replays without new T1
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — idempotency replay", () => {
  it("same Idempotency-Key on a retry returns cached result and does not re-run the turn", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const llm = makeLlm("cached-content");
    const first = await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      idempotencyKey: "client-abc",
      llm,
    });
    expect(first.replayed).toBe(false);

    // Second call with the same client key → hit cache, NOT another T1.
    const second = await runTurn(pool as any, {
      meetingId,
      participantId: p1, // unchanged
      idempotencyKey: "client-abc",
      llm,
    });
    expect(second.replayed).toBe(true);
    expect(second.contextEntryId).toBe(first.contextEntryId);
    expect((llm as any).mock.calls.length).toBe(1); // still only one LLM hit
    expect(world.meeting_context.length).toBe(1);
    expect(world.turn_records.length).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. M2 — memory-write tools stripped from LLM tool set
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — tool filtering (M2)", () => {
  it("LLM receives zero memory-write tools", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    let capturedTools: Array<{ name: string }> | null = null;
    const llm: LlmCaller = vi.fn(async (_input, tools) => {
      capturedTools = tools as Array<{ name: string }>;
      return { content: "ok", visibility: "all" as const };
    });

    await runTurn(pool as any, { meetingId, participantId: p1, llm });

    expect(capturedTools).not.toBeNull();
    const names = capturedTools!.map((t) => t.name);
    expect(names).toContain("recall");
    expect(names).toContain("searchWeb");
    expect(names).not.toContain("remember");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. LLM error → aborted, no context row written
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — LLM error → abort", () => {
  it("LLM throws → meeting aborted, no meeting_context row, turn_records failed", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const llm: LlmCaller = vi.fn(async () => {
      throw new Error("anthropic 500");
    });

    await expect(runTurn(pool as any, { meetingId, participantId: p1, llm })).rejects.toThrow(
      /LLM call failed|anthropic 500/,
    );

    expect(world.meeting_context.length).toBe(0);
    expect(world.meetings[0].state).toBe("aborted");
    expect(world.meetings[0].metadata.abort_reason).toMatch(/llm_error|unknown_error|llm_failure/);
    expect(world.turn_records.length).toBe(1);
    expect(world.turn_records[0].state).toBe("failed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Breaker open → TurnBreakerOpenError, aborted
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — breaker open", () => {
  it("CircuitOpenError from LLM → TurnBreakerOpenError, meeting aborted with breaker_open", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const llm: LlmCaller = vi.fn(async () => {
      throw new CircuitOpenError("breaker open");
    });

    await expect(runTurn(pool as any, { meetingId, participantId: p1, llm })).rejects.toBeInstanceOf(
      TurnBreakerOpenError,
    );
    expect(world.meetings[0].state).toBe("aborted");
    expect(world.meetings[0].metadata.abort_reason).toBe("breaker_open");
    expect(world.turn_records[0].state).toBe("failed");
    expect(world.turn_records[0].error).toBe("breaker_open");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. LLM timeout → TurnTimeoutError
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — timeout", () => {
  it("LLM call that never resolves within LLM_TIMEOUT_MS → TurnTimeoutError + aborted", async () => {
    vi.useFakeTimers();
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const llm: LlmCaller = vi.fn(
      () => new Promise(() => { /* never resolves */ }),
    );

    const p = runTurn(pool as any, { meetingId, participantId: p1, llm });
    // Swallow immediate errors so the rejection is only consumed after advance.
    const reject = expect(p).rejects.toBeInstanceOf(TurnTimeoutError);
    // Advance past the timeout window.
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS + 10);
    await reject;

    expect(world.meetings[0].state).toBe("aborted");
    expect(world.meetings[0].metadata.abort_reason).toBe("turn_timeout");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. F3 — wrong participant_id → out_of_order
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — F3 out-of-order", () => {
  it("passing the wrong participant_id (not next_participant_id) → 409 out_of_order", async () => {
    const world = newWorld();
    const { meetingId, p1, p2 } = seedTwoAgentMeeting(world);
    // next_participant is p1 — caller tries to force p2.
    const pool = new FakePool({ world, lock: new MeetingLock() });
    const llm = makeLlm();

    await expect(
      runTurn(pool as any, { meetingId, participantId: p2, llm }),
    ).rejects.toMatchObject({ name: "TurnStateMismatchError", code: "out_of_order" });
    expect(world.turn_records.length).toBe(0);
    expect(world.meetings[0].state).toBe("active");
    // LLM never called.
    expect((llm as any).mock.calls.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Approve-mode → waiting_for_approval
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — approve-mode", () => {
  it("speaker with participation_mode='approve' lands in waiting_for_approval with self pinned", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    world.meeting_participants.find((p) => p.id === p1)!.participation_mode = "approve";
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const result = await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      llm: makeLlm(),
    });
    expect(result.newState).toBe("waiting_for_approval");
    expect(result.nextParticipantId).toBe(p1);
    expect(world.meetings[0].metadata.waiting_since).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Profile missing → aborted before LLM
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — profile missing", () => {
  it("profile row deleted → runner aborts before reaching the LLM", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    // drop p1's profile
    world.meeting_participant_profiles = world.meeting_participant_profiles.filter(
      (pr) => !(pr.meeting_id === meetingId && pr.agent_id === 101),
    );
    const pool = new FakePool({ world, lock: new MeetingLock() });
    const llm = makeLlm();

    await expect(runTurn(pool as any, { meetingId, participantId: p1, llm })).rejects.toThrow();
    expect((llm as any).mock.calls.length).toBe(0);
    expect(world.meetings[0].state).toBe("aborted");
    expect(world.meetings[0].metadata.abort_reason).toBe("profile_missing");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. Round-robin across 3 participants — full cycle
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — round-robin", () => {
  it("three agents: p1 → p2 → p3 → p1 (cycle closes)", async () => {
    const world = newWorld();
    const { meetingId, p1, p2, p3 } = seedThreeAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });
    const llm = makeLlm();

    const r1 = await runTurn(pool as any, { meetingId, participantId: p1, llm });
    expect(r1.nextParticipantId).toBe(p2);
    const r2 = await runTurn(pool as any, { meetingId, participantId: p2, llm });
    expect(r2.nextParticipantId).toBe(p3);
    const r3 = await runTurn(pool as any, { meetingId, participantId: p3!, llm });
    expect(r3.nextParticipantId).toBe(p1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. Round-robin skips left participants
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — round-robin skips left participants", () => {
  it("if p2 has left_at set, p1 → p3 (p2 skipped)", async () => {
    const world = newWorld();
    const { meetingId, p1, p2, p3 } = seedThreeAgentMeeting(world);
    world.meeting_participants.find((p) => p.id === p2)!.left_at = new Date();
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const r1 = await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      llm: makeLlm(),
    });
    expect(r1.nextParticipantId).toBe(p3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Bro2 SF2 — private rows by OTHER agents legitimately bust idempotency
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — sequence fence is GLOBAL (Bro2 SF2)", () => {
  it("private rows written by another agent raise fence, idempotency key differs, fresh T1 runs", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    // First turn.
    await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      idempotencyKey: "k1",
      llm: makeLlm("first"),
    });
    expect(world.meeting_context.length).toBe(1);

    // Inject a PRIVATE row by another (hypothetical) agent 999 that p1 cannot
    // see. The global fence is now 2, even though p1's visible fence is 1.
    world.meeting_context.push({
      id: randomUUID(),
      meeting_id: meetingId,
      sequence_number: 2,
      content: "hidden",
      author_agent_id: 999,
      visibility: "private",
      scope_agent_ids: [],
      created_at: new Date(),
    });
    // Reset meeting state so the runner can accept another turn.
    world.meetings[0].state = "active";
    world.meetings[0].next_participant_id = world.meeting_participants[0].id;

    // Same client key as round 1, different turn — since our mock derives the
    // key from payload shape and we pass participantId again, we exercise the
    // runner's path where a brand-new clientKey is used for a fresh turn.
    const r2 = await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      idempotencyKey: "k2", // different client key — fresh cache slot
      llm: makeLlm("second"),
    });
    expect(r2.replayed).toBe(false);
    // New context row sequence_number = max(1, 2) + 1 = 3
    expect(r2.sequenceNumber).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. State-transition table coverage
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — state-transition guards", () => {
  const badStates: MeetingStateDb[] = ["pending", "completed", "aborted", "turn_in_progress"];
  for (const s of badStates) {
    it(`rejects start from state=${s}`, async () => {
      const world = newWorld();
      const { meetingId, p1 } = seedTwoAgentMeeting(world);
      world.meetings[0].state = s;
      if (s === "turn_in_progress") world.meetings[0].current_turn_id = "some-turn";
      const pool = new FakePool({ world, lock: new MeetingLock() });
      await expect(
        runTurn(pool as any, { meetingId, participantId: p1, llm: makeLlm() }),
      ).rejects.toMatchObject({ name: "TurnStateMismatchError" });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. Turn cap
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — turn cap", () => {
  it(`meeting with ${MAX_TURNS_PER_MEETING} completed turn_records → turn_cap_exceeded`, async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    for (let i = 0; i < MAX_TURNS_PER_MEETING; i++) {
      world.turn_records.push({
        id: randomUUID(),
        meeting_id: meetingId,
        participant_id: p1,
        sequence_fence: i,
        state: "completed",
        started_at: new Date(),
        completed_at: new Date(),
        error: null,
      });
    }
    const pool = new FakePool({ world, lock: new MeetingLock() });

    await expect(
      runTurn(pool as any, { meetingId, participantId: p1, llm: makeLlm() }),
    ).rejects.toMatchObject({
      name: "TurnStateMismatchError",
      code: "turn_cap_exceeded",
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16. Meeting not found → T1 rollback, no side effects
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — meeting not found", () => {
  it("unknown meetingId → state_mismatch; no turn_records insert", async () => {
    const world = newWorld();
    seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });
    await expect(
      runTurn(pool as any, {
        meetingId: "00000000-0000-0000-0000-000000000000",
        participantId: "p-nonexistent",
        llm: makeLlm(),
      }),
    ).rejects.toMatchObject({ name: "TurnStateMismatchError", code: "state_mismatch" });
    expect(world.turn_records.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17. Already-running (current_turn_id pinned) → already_running
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — already running", () => {
  it("meeting with current_turn_id pinned → already_running", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    // Construct the pathological state: state=active but current_turn_id set
    // (impossible in normal flow — this defends against data drift / manual
    // tinkering).
    world.meetings[0].current_turn_id = randomUUID();
    const pool = new FakePool({ world, lock: new MeetingLock() });
    await expect(
      runTurn(pool as any, { meetingId, participantId: p1, llm: makeLlm() }),
    ).rejects.toMatchObject({ name: "TurnStateMismatchError", code: "already_running" });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18. Event bus — turn.completed emitted AFTER commit
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — events", () => {
  it("meeting.turn.completed is emitted exactly once, after T2 commits", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });
    const bus = new RecordingMeetingEventBus();

    const result = await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      llm: makeLlm(),
      eventBus: bus,
    });
    expect(bus.events.length).toBe(1);
    expect(bus.events[0].event).toBe("meeting.turn.completed");
    expect(bus.events[0].payload.sequenceNumber).toBe(result.sequenceNumber);
    // By the time the event fires, the meeting_context row exists.
    expect(world.meeting_context.length).toBe(1);
  });

  it("meeting.state.changed emitted on abort path", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });
    const bus = new RecordingMeetingEventBus();

    const llm: LlmCaller = vi.fn(async () => {
      throw new CircuitOpenError("breaker open");
    });
    await expect(
      runTurn(pool as any, { meetingId, participantId: p1, llm, eventBus: bus }),
    ).rejects.toBeInstanceOf(TurnBreakerOpenError);

    expect(bus.events.length).toBe(1);
    expect(bus.events[0].event).toBe("meeting.state.changed");
    expect(bus.events[0].payload.state).toBe("aborted");
    expect(bus.events[0].payload.reason).toBe("breaker_open");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19. Idempotency store — fresh key stores result after commit
// ═════════════════════════════════════════════════════════════════════════════

describe("runTurn — idempotency store on commit", () => {
  it("fresh idempotency key → storeIdempotencyResult called exactly once on commit", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    await runTurn(pool as any, {
      meetingId,
      participantId: p1,
      idempotencyKey: "new-key",
      llm: makeLlm(),
    });
    expect(mockStoreIdempotencyResult).toHaveBeenCalledTimes(1);
    const [key, result] = mockStoreIdempotencyResult.mock.calls[0];
    expect(key).toMatch(/^idem:meeting_turn:/);
    expect((result as any).sequenceNumber).toBe(1);
  });

  it("failure path → storeIdempotencyResult NOT called (allow retry)", async () => {
    const world = newWorld();
    const { meetingId, p1 } = seedTwoAgentMeeting(world);
    const pool = new FakePool({ world, lock: new MeetingLock() });

    const llm: LlmCaller = vi.fn(async () => {
      throw new Error("transient");
    });
    await expect(
      runTurn(pool as any, {
        meetingId,
        participantId: p1,
        idempotencyKey: "k",
        llm,
      }),
    ).rejects.toThrow();
    expect(mockStoreIdempotencyResult).not.toHaveBeenCalled();
  });
});

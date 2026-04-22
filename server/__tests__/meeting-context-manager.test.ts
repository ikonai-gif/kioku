/**
 * Unit tests for server/lib/meeting-context-manager.ts  (W9 Item 1).
 *
 * MCM is pure read-only — it issues two classes of SQL:
 *   A. A join over meetings / meeting_participants / agents /
 *      meeting_participant_profiles keyed on (meeting_id, participant_id).
 *   B. A visibility-filtered scan of meeting_context for a given agent.
 *
 * These tests don't need a real Postgres. We stand up a `FakeDbExecutor`
 * that understands just the two SQL shapes MCM emits and serves rows from
 * in-memory maps. Matching is SQL-shape based (checks for stable landmarks
 * in the query text), not full parsing — if MCM's SQL changes in a way that
 * affects behaviour the fake throws with "unhandled SQL" so the test fails
 * loudly rather than silently mis-matching.
 *
 * Integration-level coverage (real Postgres, schema-backed CHECK constraints,
 * GIN index behaviour) lives in `meeting-context-manager.integration.test.ts`
 * and runs under the separate integration suite (needs Docker).
 *
 * W9 plan v2 — Item 1 target: ~16 tests. This file covers:
 *   1. Happy path → TurnInput well-formed
 *   2. Meeting not found → MCMNotFoundError("meeting_not_found")
 *   3. Participant not found → MCMNotFoundError("participant_not_found")
 *   4. Left participant → ParticipantInactiveError
 *   5. Profile missing (no profile row) → ProfileMissingError
 *   6. includeContext=false → empty visibleContext, lastSequence=0
 *   7. Empty context → lastSequence=0
 *   8. Non-empty context → lastSequence = max sequence_number visible
 *   9. visibility='all' always included
 *  10. visibility='owner' EXCLUDED for turn-taking agent (F1 read-side)
 *  11. visibility='scoped' — agentId in scope_agent_ids → included
 *  12. visibility='scoped' — agentId NOT in scope_agent_ids → excluded (3-agent meeting)
 *  13. visibility='private' — author is requester → included (F1 forward-compat)
 *  14. visibility='private' — requester in scope_agent_ids → included
 *  15. visibility='private' — requester neither author nor in scope → excluded (F1 key case)
 *  16. buildSystemPrompt includes allowed/blocked topics verbatim (with escape)
 *  17. buildSystemPrompt — autonomy_level → instruction stanza mapping (4 cases in 1 test)
 *  18. buildSystemPrompt deterministic (snapshot)
 *  19. Topic escape: commas and newlines normalized so list delimiters stay intact
 *  20. Invalid autonomy_level string → throws (defensive)
 *  21. fetchLastVisibleSequence — returns 0 on empty
 *  22. fetchLastVisibleSequence — returns correct value on non-empty
 *  23. listOwnedActiveAgentIds — returns only active participants owned by user
 *
 * (Count is a few over 16 because plan v2 calls for F1 read-side coverage as
 * a separate test; splitting hairs to keep each case single-purpose makes the
 * failure mode readable.)
 */

import { describe, it, expect } from "vitest";
import type { QueryResult } from "pg";
import {
  buildSystemPrompt,
  buildTurnInput,
  fetchLastVisibleSequence,
  fetchVisibleContext,
  listOwnedActiveAgentIds,
  MCMNotFoundError,
  ParticipantInactiveError,
  ProfileMissingError,
  type AutonomyLevel,
  type ContextVisibility,
  type DbExecutor,
} from "../lib/meeting-context-manager";

// ── Fake rows matching the schema column names MCM reads ─────────────────────

interface FakeMeeting {
  id: string;
  state?: string;
}
interface FakeParticipant {
  id: string;
  meeting_id: string;
  agent_id: number;
  owner_user_id: number;
  left_at: Date | null;
}
interface FakeAgent {
  id: number;
  name: string;
  description: string | null;
  llm_model: string | null;
}
interface FakeProfile {
  meeting_id: string;
  agent_id: number;
  autonomy_level: string;
  allowed_topics: string[];
  blocked_topics: string[];
  memory_scope: Record<string, unknown>;
  carry_over_memory: boolean;
}
interface FakeContextRow {
  id: string;
  meeting_id: string;
  sequence_number: number;
  content: string;
  author_agent_id: number | null;
  visibility: ContextVisibility;
  scope_agent_ids: number[];
  created_at: Date;
}

interface FakeWorld {
  meetings: FakeMeeting[];
  participants: FakeParticipant[];
  agents: FakeAgent[];
  profiles: FakeProfile[];
  context: FakeContextRow[];
}

/** Build an empty world — helpers below mutate it. */
function newWorld(): FakeWorld {
  return { meetings: [], participants: [], agents: [], profiles: [], context: [] };
}

/** Minimal DbExecutor that recognises MCM's exact SQL shapes. */
function makeFakeDb(world: FakeWorld): DbExecutor {
  async function query(text: string, params?: any[]): Promise<QueryResult> {
    const sql = text.trim();

    // ── A. The big join in buildTurnInput ────────────────────────────────────
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM meetings m") &&
      sql.includes("LEFT JOIN meeting_participants mp") &&
      sql.includes("LEFT JOIN agents a") &&
      sql.includes("LEFT JOIN meeting_participant_profiles mpp")
    ) {
      const [meetingId, participantId] = params as [string, string];
      const meeting = world.meetings.find((m) => m.id === meetingId);
      if (!meeting) return wrap([]);
      // LEFT JOINs in SQL yield a single row with NULL where a table has no
      // match — the fake must reproduce that or MCM's "participant_id null →
      // participant_not_found" branch never fires.
      const participant = world.participants.find(
        (p) => p.meeting_id === meetingId && p.id === participantId,
      );
      const agent = participant
        ? world.agents.find((a) => a.id === participant.agent_id)
        : undefined;
      const profile = participant
        ? world.profiles.find(
            (pr) => pr.meeting_id === meetingId && pr.agent_id === participant.agent_id,
          )
        : undefined;
      return wrap([
        {
          meeting_id: meeting.id,
          meeting_state: meeting.state ?? "active",
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

    // ── B. Visible-context scan in fetchVisibleContext ────────────────────────
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM meeting_context") &&
      sql.includes("scope_agent_ids") &&
      sql.includes("LIMIT")
    ) {
      const [meetingId, agentId, limit] = params as [string, number, number];
      const visible = world.context
        .filter((r) => r.meeting_id === meetingId)
        .filter((r) => isVisibleToAgent(r, agentId))
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .slice(0, limit);
      return wrap(visible);
    }

    // ── C. fetchLastVisibleSequence ───────────────────────────────────────────
    if (
      sql.startsWith("SELECT") &&
      sql.includes("COALESCE(MAX(sequence_number), 0)") &&
      sql.includes("FROM meeting_context")
    ) {
      const [meetingId, agentId] = params as [string, number];
      const seq = world.context
        .filter((r) => r.meeting_id === meetingId)
        .filter((r) => isVisibleToAgent(r, agentId))
        .reduce((max, r) => Math.max(max, r.sequence_number), 0);
      return wrap([{ seq }]);
    }

    // ── D. fetchOwnedActiveAgentIds ───────────────────────────────────────────
    if (
      sql.startsWith("SELECT DISTINCT agent_id") &&
      sql.includes("FROM meeting_participants") &&
      sql.includes("left_at IS NULL")
    ) {
      const [meetingId, ownerUserId] = params as [string, number];
      const ids = Array.from(
        new Set(
          world.participants
            .filter(
              (p) =>
                p.meeting_id === meetingId &&
                p.owner_user_id === ownerUserId &&
                p.left_at === null,
            )
            .map((p) => p.agent_id),
        ),
      );
      return wrap(ids.map((id) => ({ agent_id: id })));
    }

    throw new Error(`FakeDbExecutor: unhandled SQL (first 120 chars): ${sql.slice(0, 120)}`);
  }
  // DbExecutor union requires a `.query` method matching the pg signature.
  // We only need `query(text, params)` from MCM's call sites.
  return { query } as unknown as DbExecutor;
}

function wrap(rows: any[]): QueryResult {
  return {
    rows,
    rowCount: rows.length,
    command: "SELECT",
    oid: 0,
    fields: [],
  } as QueryResult;
}

/**
 * Replicates MCM's visibility filter for fake-DB assertions. Kept in sync with
 * fetchVisibleContext SQL — any divergence here would make the tests lie, so
 * when MCM SQL changes this logic must update alongside.
 */
function isVisibleToAgent(r: FakeContextRow, agentId: number): boolean {
  switch (r.visibility) {
    case "all":
      return true;
    case "owner":
      return false; // agents running turns never see owner-scoped rows
    case "scoped":
      return r.scope_agent_ids.includes(agentId);
    case "private":
      return r.author_agent_id === agentId || r.scope_agent_ids.includes(agentId);
    default:
      return false;
  }
}

// ── Shared seed builders ─────────────────────────────────────────────────────

function seedHappyWorld(): {
  world: FakeWorld;
  meetingId: string;
  participantId: string;
  agentId: number;
  ownerUserId: number;
} {
  const world = newWorld();
  const meetingId = "11111111-1111-1111-1111-111111111111";
  const participantId = "22222222-2222-2222-2222-222222222222";
  const agentId = 100;
  const ownerUserId = 10;
  world.meetings.push({ id: meetingId, state: "active" });
  world.agents.push({
    id: agentId,
    name: "Luca",
    description: "KIOKU companion agent.",
    llm_model: "claude-sonnet-4-6",
  });
  world.participants.push({
    id: participantId,
    meeting_id: meetingId,
    agent_id: agentId,
    owner_user_id: ownerUserId,
    left_at: null,
  });
  world.profiles.push({
    meeting_id: meetingId,
    agent_id: agentId,
    autonomy_level: "propose",
    allowed_topics: ["memory design", "voice drift"],
    blocked_topics: ["user personal data"],
    memory_scope: {},
    carry_over_memory: false,
  });
  return { world, meetingId, participantId, agentId, ownerUserId };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("MCM — buildTurnInput happy path & error cases", () => {
  it("happy path returns a well-formed TurnInput", async () => {
    const { world, meetingId, participantId, agentId, ownerUserId } = seedHappyWorld();
    const db = makeFakeDb(world);
    const out = await buildTurnInput(db, { meetingId, participantId });

    expect(out.meetingId).toBe(meetingId);
    expect(out.participantId).toBe(participantId);
    expect(out.agentId).toBe(agentId);
    expect(out.ownerUserId).toBe(ownerUserId);
    expect(out.llmModel).toBe("claude-sonnet-4-6");
    expect(out.autonomyLevel).toBe("propose");
    expect(out.visibleContext).toEqual([]);
    expect(out.lastSequence).toBe(0);
    // System prompt must include agent name, description, and topics verbatim.
    expect(out.systemPrompt).toContain("Luca");
    expect(out.systemPrompt).toContain("KIOKU companion agent.");
    expect(out.systemPrompt).toContain("memory design");
    expect(out.systemPrompt).toContain("voice drift");
    expect(out.systemPrompt).toContain("user personal data");
  });

  it("throws MCMNotFoundError('meeting_not_found') when meeting id unknown", async () => {
    const { world, participantId } = seedHappyWorld();
    const db = makeFakeDb(world);
    // SF1 (bro2): assert on .code not just instanceof so a future refactor that
    // reuses MCMNotFoundError for a different code path cannot silently pass.
    try {
      await buildTurnInput(db, {
        meetingId: "00000000-0000-0000-0000-000000000000",
        participantId,
      });
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(MCMNotFoundError);
      expect((e as MCMNotFoundError).code).toBe("meeting_not_found");
    }
  });

  it("throws MCMNotFoundError('participant_not_found') when participant id unknown", async () => {
    const { world, meetingId } = seedHappyWorld();
    const db = makeFakeDb(world);
    try {
      await buildTurnInput(db, {
        meetingId,
        participantId: "33333333-3333-3333-3333-333333333333",
      });
      throw new Error("expected rejection");
    } catch (e) {
      expect(e).toBeInstanceOf(MCMNotFoundError);
      expect((e as MCMNotFoundError).code).toBe("participant_not_found");
    }
  });

  it("throws ParticipantInactiveError when left_at is set", async () => {
    const { world, meetingId, participantId } = seedHappyWorld();
    world.participants[0]!.left_at = new Date();
    const db = makeFakeDb(world);
    await expect(
      buildTurnInput(db, { meetingId, participantId }),
    ).rejects.toBeInstanceOf(ParticipantInactiveError);
  });

  it("throws ProfileMissingError when no profile row exists for agent", async () => {
    const { world, meetingId, participantId } = seedHappyWorld();
    world.profiles = []; // drop the profile
    const db = makeFakeDb(world);
    await expect(
      buildTurnInput(db, { meetingId, participantId }),
    ).rejects.toBeInstanceOf(ProfileMissingError);
  });

  it("includeContext=false returns empty visibleContext and lastSequence=0", async () => {
    const { world, meetingId, participantId, agentId } = seedHappyWorld();
    // Seed a visible row — must still be suppressed.
    world.context.push({
      id: "c1",
      meeting_id: meetingId,
      sequence_number: 1,
      content: "hello",
      author_agent_id: agentId,
      visibility: "all",
      scope_agent_ids: [],
      created_at: new Date(),
    });
    const db = makeFakeDb(world);
    const out = await buildTurnInput(db, {
      meetingId,
      participantId,
      includeContext: false,
    });
    expect(out.visibleContext).toEqual([]);
    expect(out.lastSequence).toBe(0);
  });

  it("throws on invalid autonomy_level value (defensive)", async () => {
    const { world, meetingId, participantId } = seedHappyWorld();
    world.profiles[0]!.autonomy_level = "gibberish";
    const db = makeFakeDb(world);
    await expect(buildTurnInput(db, { meetingId, participantId })).rejects.toThrow(
      /invalid autonomy_level/,
    );
  });
});

describe("MCM — visibility filter (F1 read-side)", () => {
  function seedThreeAgentWorld() {
    const world = newWorld();
    const meetingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const A = 1; // the turn-taker
    const B = 2;
    const C = 3;
    const ownerUserId = 10;
    world.meetings.push({ id: meetingId, state: "active" });
    for (const [agentId, partId] of [
      [A, "p-a-a-a-a-a-a-a-a-a-a-a-a-a-a-a"],
      [B, "p-b-b-b-b-b-b-b-b-b-b-b-b-b-b-b"],
      [C, "p-c-c-c-c-c-c-c-c-c-c-c-c-c-c-c"],
    ] as const) {
      world.agents.push({ id: agentId, name: `Agent${agentId}`, description: null, llm_model: null });
      world.participants.push({
        id: partId,
        meeting_id: meetingId,
        agent_id: agentId,
        owner_user_id: ownerUserId,
        left_at: null,
      });
      world.profiles.push({
        meeting_id: meetingId,
        agent_id: agentId,
        autonomy_level: "propose",
        allowed_topics: [],
        blocked_topics: [],
        memory_scope: {},
        carry_over_memory: false,
      });
    }
    return { world, meetingId, A, B, C, ownerUserId };
  }

  it("visibility='all' rows are visible to every agent", async () => {
    const { world, meetingId, A } = seedThreeAgentWorld();
    world.context.push(ctx(meetingId, 1, "visible to all", null, "all", []));
    const db = makeFakeDb(world);
    const rows = await fetchVisibleContext(db, meetingId, A, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("visible to all");
  });

  it("visibility='owner' rows are EXCLUDED for turn-taking agent", async () => {
    // Plan v2 invariant #2: turn inputs are agent-scoped, not owner-scoped.
    // The creator still sees these via GET /context — that path is not MCM.
    const { world, meetingId, A } = seedThreeAgentWorld();
    world.context.push(ctx(meetingId, 1, "owner-only note", null, "owner", []));
    const db = makeFakeDb(world);
    const rows = await fetchVisibleContext(db, meetingId, A, 10);
    expect(rows).toHaveLength(0);
  });

  it("visibility='scoped' — agent IN scope is included, others excluded (3-agent)", async () => {
    const { world, meetingId, A, B, C } = seedThreeAgentWorld();
    world.context.push(ctx(meetingId, 1, "for A and B", null, "scoped", [A, B]));
    const db = makeFakeDb(world);
    expect((await fetchVisibleContext(db, meetingId, A, 10))).toHaveLength(1);
    expect((await fetchVisibleContext(db, meetingId, B, 10))).toHaveLength(1);
    expect((await fetchVisibleContext(db, meetingId, C, 10))).toHaveLength(0);
  });

  it("visibility='private' — author sees, scope sees, others do NOT (F1 key case)", async () => {
    const { world, meetingId, A, B, C } = seedThreeAgentWorld();
    // Private row authored by A, scoped additionally to B. C must NOT see it.
    world.context.push(ctx(meetingId, 1, "secret", A, "private", [B]));
    const db = makeFakeDb(world);
    expect((await fetchVisibleContext(db, meetingId, A, 10))).toHaveLength(1); // author
    expect((await fetchVisibleContext(db, meetingId, B, 10))).toHaveLength(1); // in scope
    const cRows = await fetchVisibleContext(db, meetingId, C, 10);
    // The critical F1 assertion: no leak to non-scoped, non-author agent.
    expect(cRows).toHaveLength(0);
    for (const r of cRows) {
      expect(r.content).not.toContain("secret");
    }
  });

  it("empty context → lastSequence=0 in TurnInput", async () => {
    const { world, meetingId } = seedThreeAgentWorld();
    const participantId = world.participants[0]!.id;
    const db = makeFakeDb(world);
    const out = await buildTurnInput(db, { meetingId, participantId });
    expect(out.lastSequence).toBe(0);
    expect(out.visibleContext).toEqual([]);
  });

  it("non-empty context → lastSequence = MAX(sequence_number visible)", async () => {
    const { world, meetingId, A, B } = seedThreeAgentWorld();
    // seq 1 visible to A (all), seq 2 scoped to B only, seq 3 visible to A (all).
    // MAX visible to A should be 3, NOT 2 or undefined.
    world.context.push(ctx(meetingId, 1, "one", null, "all", []));
    world.context.push(ctx(meetingId, 2, "two-B", null, "scoped", [B]));
    world.context.push(ctx(meetingId, 3, "three", null, "all", []));
    const participantId = world.participants[0]!.id; // the A participant
    const db = makeFakeDb(world);
    const out = await buildTurnInput(db, { meetingId, participantId });
    expect(out.visibleContext.map((r) => r.sequenceNumber)).toEqual([1, 3]);
    expect(out.lastSequence).toBe(3);
  });

  // bro2 consistency test: the dedicated fence helper must return the same
  // value as the last-visible row inside the assembled TurnInput (or 0 when
  // there are no visible rows). This is the invariant the turn-runner relies
  // on for idempotency, so it belongs in this file even though it touches two
  // public entry points. A mix of all / scoped / private + an out-of-scope
  // row exercises every branch of the shared visibility filter.
  it("fetchLastVisibleSequence agrees with visibleContext[last].sequenceNumber (all/scoped/private mix)", async () => {
    const { world, meetingId, A, B, C } = seedThreeAgentWorld();
    // A is the turn-taking agent.
    world.context.push(ctx(meetingId, 1, "seq1-all", null, "all", []));
    world.context.push(ctx(meetingId, 2, "seq2-owner", null, "owner", [])); // hidden from A
    world.context.push(ctx(meetingId, 3, "seq3-scoped-BC", null, "scoped", [B, C])); // hidden from A
    world.context.push(ctx(meetingId, 4, "seq4-private-A", A, "private", [])); // author A sees
    world.context.push(ctx(meetingId, 5, "seq5-private-B", B, "private", [B])); // A does not see
    world.context.push(ctx(meetingId, 6, "seq6-all", null, "all", []));
    const participantId = world.participants[0]!.id; // participant bound to A
    const agentId = A;
    const db = makeFakeDb(world);

    const out = await buildTurnInput(db, { meetingId, participantId });
    const fenceOnly = await fetchLastVisibleSequence(db, meetingId, agentId);

    const expected =
      out.visibleContext.length > 0
        ? out.visibleContext[out.visibleContext.length - 1]!.sequenceNumber
        : 0;
    expect(fenceOnly).toBe(expected);
    // Also assert A actually sees the expected subset (defensive).
    expect(out.visibleContext.map((r) => r.sequenceNumber)).toEqual([1, 4, 6]);
    expect(out.lastSequence).toBe(6);
  });

  // bro2 contextLimit test: with more visible rows than the requested limit,
  // buildTurnInput must return exactly `limit` rows and they must be the
  // EARLIEST ones (ORDER BY sequence_number ASC LIMIT n). Callers downstream
  // assume ascending order for prompt assembly, so this pins both order and
  // truncation side.
  it("respects contextLimit by returning the earliest visible rows in ascending order", async () => {
    const { world, meetingId } = seedThreeAgentWorld();
    for (let seq = 1; seq <= 20; seq++) {
      world.context.push(ctx(meetingId, seq, `m-${seq}`, null, "all", []));
    }
    const participantId = world.participants[0]!.id;
    const db = makeFakeDb(world);

    const out = await buildTurnInput(db, {
      meetingId,
      participantId,
      contextLimit: 5,
    });

    expect(out.visibleContext).toHaveLength(5);
    expect(out.visibleContext.map((r) => r.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    // lastSequence mirrors the last row we actually returned (not the true MAX
    // in the table) — this matches the buildTurnInput contract.
    expect(out.lastSequence).toBe(5);
  });
});

describe("MCM — buildSystemPrompt (deterministic)", () => {
  it("includes allowed and blocked topics verbatim", () => {
    const prompt = buildSystemPrompt({
      agentName: "Luca",
      agentDescription: "Companion.",
      autonomyLevel: "propose",
      allowedTopics: ["voice drift", "retrieval design"],
      blockedTopics: ["medical advice"],
    });
    expect(prompt).toContain("Luca");
    expect(prompt).toContain("Companion.");
    expect(prompt).toContain("voice drift");
    expect(prompt).toContain("retrieval design");
    expect(prompt).toContain("medical advice");
    // Allowed/blocked must be distinct stanzas so the LLM can parse them.
    expect(prompt).toMatch(/Allowed topics[^\n]*voice drift/);
    expect(prompt).toMatch(/Blocked topics[^\n]*medical advice/);
  });

  it("maps every AutonomyLevel to a distinct instruction stanza", () => {
    const levels: AutonomyLevel[] = ["observe", "propose", "commit", "execute"];
    const stanzas = levels.map((lvl) =>
      buildSystemPrompt({
        agentName: "x",
        agentDescription: null,
        autonomyLevel: lvl,
        allowedTopics: [],
        blockedTopics: [],
      }),
    );
    // All four unique.
    expect(new Set(stanzas).size).toBe(4);
    expect(stanzas[0]).toContain("OBSERVER");
    expect(stanzas[1]).toContain("PROPOSE");
    // SF2 (bro2): use a phrase-level regex so the 'commit' stanza cannot be
    // accidentally satisfied by another level that happens to contain the
    // substring 'commit' (e.g. "commitment" in a doc tweak).
    expect(stanzas[2]).toMatch(/commit decisions/i);
    expect(stanzas[3]).toContain("EXECUTE");
  });

  it("deterministic: same inputs → byte-identical output", () => {
    const args = {
      agentName: "Luca",
      agentDescription: "c",
      autonomyLevel: "propose" as AutonomyLevel,
      allowedTopics: ["a", "b"],
      blockedTopics: ["x"],
    };
    expect(buildSystemPrompt(args)).toBe(buildSystemPrompt(args));
  });

  it("escapes commas and newlines in topics so the list delimiter survives", () => {
    const prompt = buildSystemPrompt({
      agentName: "x",
      agentDescription: null,
      autonomyLevel: "propose",
      // Topic with embedded comma + newline — must not fracture the list.
      allowedTopics: ["voice, tone", "retrieval\ndesign"],
      blockedTopics: [],
    });
    // No embedded comma/newline should survive inside a topic slot.
    // Commas in the output belong only to the list delimiter.
    const allowedLine = prompt.match(/Allowed topics[^\n]*/)![0];
    // Exactly two topic entries split by the list delimiter ", ".
    const topicsPart = allowedLine.replace(/^Allowed topics \(focus your contributions here\): /, "").replace(/\.$/, "");
    const pieces = topicsPart.split(", ");
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toBe("voice tone");
    expect(pieces[1]).toBe("retrieval design");
  });

  it("omits description stanza when description is null or blank", () => {
    const withNull = buildSystemPrompt({
      agentName: "x",
      agentDescription: null,
      autonomyLevel: "propose",
      allowedTopics: [],
      blockedTopics: [],
    });
    const withBlank = buildSystemPrompt({
      agentName: "x",
      agentDescription: "   ",
      autonomyLevel: "propose",
      allowedTopics: [],
      blockedTopics: [],
    });
    // Both should be equal (blank treated as absent).
    expect(withNull).toBe(withBlank);
  });
});

describe("MCM — helpers", () => {
  it("fetchLastVisibleSequence returns 0 on empty", async () => {
    const { world, meetingId } = seedHappyWorld();
    const db = makeFakeDb(world);
    expect(await fetchLastVisibleSequence(db, meetingId, 100)).toBe(0);
  });

  it("fetchLastVisibleSequence returns MAX visible sequence", async () => {
    const { world, meetingId, agentId } = seedHappyWorld();
    world.context.push(ctx(meetingId, 1, "a", null, "all", []));
    world.context.push(ctx(meetingId, 5, "e", null, "all", []));
    world.context.push(ctx(meetingId, 3, "c", null, "scoped", [999])); // not visible to our agent
    const db = makeFakeDb(world);
    expect(await fetchLastVisibleSequence(db, meetingId, agentId)).toBe(5);
  });

  it("listOwnedActiveAgentIds returns only active participants owned by user", async () => {
    const world = newWorld();
    const meetingId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const ownerA = 10;
    const ownerB = 20;
    world.meetings.push({ id: meetingId, state: "active" });
    // Owner A has two active agents; one more left.
    // Owner B has one active agent.
    world.participants.push(
      { id: "p1", meeting_id: meetingId, agent_id: 1, owner_user_id: ownerA, left_at: null },
      { id: "p2", meeting_id: meetingId, agent_id: 2, owner_user_id: ownerA, left_at: null },
      { id: "p3", meeting_id: meetingId, agent_id: 3, owner_user_id: ownerA, left_at: new Date() },
      { id: "p4", meeting_id: meetingId, agent_id: 4, owner_user_id: ownerB, left_at: null },
    );
    const db = makeFakeDb(world);
    const idsA = (await listOwnedActiveAgentIds(db, meetingId, ownerA)).sort();
    expect(idsA).toEqual([1, 2]);
    const idsB = await listOwnedActiveAgentIds(db, meetingId, ownerB);
    expect(idsB).toEqual([4]);
  });

  it("MCM does not perform writes during buildTurnInput (read-only invariant)", async () => {
    const { world, meetingId, participantId } = seedHappyWorld();
    // Wrap query so any INSERT/UPDATE/DELETE attempt would fail visibly.
    const calls: string[] = [];
    const inner = makeFakeDb(world);
    const db: DbExecutor = {
      // @ts-expect-error — minimal shape is sufficient here
      query: (text: string, params?: any[]) => {
        calls.push(text.trim().slice(0, 12).toUpperCase());
        if (/^(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)/.test(text.trim())) {
          throw new Error(`write attempted: ${text.slice(0, 60)}`);
        }
        return (inner as any).query(text, params);
      },
    };
    await buildTurnInput(db, { meetingId, participantId });
    // Every call we made is a SELECT.
    for (const c of calls) {
      expect(c.startsWith("SELECT")).toBe(true);
    }
  });
});

// ── Helper: build a fake context row concisely ───────────────────────────────

function ctx(
  meetingId: string,
  seq: number,
  content: string,
  authorAgentId: number | null,
  visibility: ContextVisibility,
  scope: number[],
): FakeContextRow {
  return {
    id: `c-${seq}`,
    meeting_id: meetingId,
    sequence_number: seq,
    content,
    author_agent_id: authorAgentId,
    visibility,
    scope_agent_ids: scope,
    created_at: new Date(Date.UTC(2026, 3, 22, 10, 0, seq)),
  };
}

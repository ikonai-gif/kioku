/**
 * Tests for Meeting Room API (server/routes/meetings.ts).
 *
 * Uses an in-memory FakePg that matches just enough of node-postgres to
 * cover the endpoints under test: pool.query, pool.connect() → client,
 * client.query with BEGIN/COMMIT/ROLLBACK + a per-meeting serialization
 * lock so the concurrent sequence-number test is deterministic, not flaky.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";

// ── Fake pg (tiny, covers only patterns in meetings.ts) ──────────────────────
type Row = Record<string, any>;

interface Meeting {
  id: string;
  room_id: number;
  creator_user_id: number;
  state: string;
  created_at: Date;
  ended_at: Date | null;
  metadata: Row;
}
interface Participant {
  id: string;
  meeting_id: string;
  agent_id: number;
  owner_user_id: number;
  participation_mode: string;
  joined_at: Date;
  left_at: Date | null;
}
interface ContextRow {
  id: string;
  meeting_id: string;
  sequence_number: number;
  content: string;
  author_agent_id: number | null;
  visibility: string;
  scope_agent_ids: number[];
  created_at: Date;
}

class FakePg {
  rooms = new Map<number, { id: number; user_id: number }>();
  agents = new Map<number, { id: number; user_id: number }>();
  meetings = new Map<string, Meeting>();
  participants: Participant[] = [];
  context: ContextRow[] = [];

  // meetingId → promise queue for row lock serialization (FOR UPDATE)
  private locks = new Map<string, Promise<void>>();

  reset() {
    this.rooms.clear();
    this.agents.clear();
    this.meetings.clear();
    this.participants = [];
    this.context = [];
    this.locks.clear();
  }

  async acquireMeetingLock(meetingId: string): Promise<() => void> {
    const prev = this.locks.get(meetingId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(meetingId, prev.then(() => next));
    await prev;
    return release;
  }

  // Simulates pool.connect() returning a client (supports BEGIN/COMMIT/ROLLBACK + FOR UPDATE lock)
  connect() {
    const db = this;
    let inTx = false;
    let lockRelease: (() => void) | null = null;

    function release() {
      if (lockRelease) {
        lockRelease();
        lockRelease = null;
      }
    }

    return Promise.resolve({
      query: (sql: string, params?: any[]) => db.runQuery(sql, params, {
        inTx,
        setInTx: (v: boolean) => { inTx = v; },
        acquireLockFor: async (mid: string) => {
          if (lockRelease) return; // already holds a lock (only one at a time per client in our usage)
          lockRelease = await db.acquireMeetingLock(mid);
        },
      }),
      release,
    });
  }

  async query(sql: string, params?: any[]) {
    return this.runQuery(sql, params, {
      inTx: false,
      setInTx: () => {},
      acquireLockFor: async () => {},
    });
  }

  private async runQuery(
    sql: string,
    params: any[] | undefined,
    ctx: {
      inTx: boolean;
      setInTx: (v: boolean) => void;
      acquireLockFor: (mid: string) => Promise<void>;
    },
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const s = sql.trim();

    if (/^BEGIN\b/i.test(s)) { ctx.setInTx(true); return { rows: [], rowCount: 0 }; }
    if (/^COMMIT\b/i.test(s)) { ctx.setInTx(false); return { rows: [], rowCount: 0 }; }
    if (/^ROLLBACK\b/i.test(s)) { ctx.setInTx(false); return { rows: [], rowCount: 0 }; }

    // rooms lookup
    if (/SELECT\s+user_id\s+FROM\s+rooms\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
      const r = this.rooms.get(params![0]);
      return { rows: r ? [{ user_id: r.user_id }] : [], rowCount: r ? 1 : 0 };
    }

    // agents lookup by id + user
    if (/SELECT\s+id\s+FROM\s+agents\s+WHERE\s+id\s*=\s*\$1\s+AND\s+user_id\s*=\s*\$2/i.test(s)) {
      const a = this.agents.get(params![0]);
      const ok = a && a.user_id === params![1];
      return { rows: ok ? [{ id: a.id }] : [], rowCount: ok ? 1 : 0 };
    }
    if (/SELECT\s+id\s+FROM\s+agents\s+WHERE\s+id\s*=\s*ANY\(\$1::int\[\]\)\s+AND\s+user_id\s*=\s*\$2/i.test(s)) {
      const ids: number[] = params![0];
      const uid = params![1];
      const rows = ids
        .map((id) => this.agents.get(id))
        .filter((a): a is { id: number; user_id: number } => !!a && a.user_id === uid)
        .map((a) => ({ id: a.id }));
      return { rows, rowCount: rows.length };
    }

    // INSERT INTO meetings
    if (/INSERT\s+INTO\s+meetings/i.test(s)) {
      const [room_id, creator_user_id, metaJson] = params as [number, number, string];
      const m: Meeting = {
        id: randomUUID(),
        room_id,
        creator_user_id,
        state: "pending",
        created_at: new Date(),
        ended_at: null,
        metadata: JSON.parse(metaJson),
      };
      this.meetings.set(m.id, m);
      return { rows: [{ ...m }], rowCount: 1 };
    }

    // SELECT ... FROM meetings WHERE id = $1 FOR UPDATE
    if (/SELECT\s+.*\s+FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(s)) {
      const id = params![0];
      await ctx.acquireLockFor(id);
      const m = this.meetings.get(id);
      if (!m) return { rows: [], rowCount: 0 };
      return {
        rows: [{ id: m.id, creator_user_id: m.creator_user_id, state: m.state }],
        rowCount: 1,
      };
    }

    // Plain SELECT of meeting (no FOR UPDATE)
    if (/SELECT\s+id,\s*room_id,\s*creator_user_id/i.test(s) && /FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1/i.test(s) && !/FOR\s+UPDATE/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ ...m }] : [], rowCount: m ? 1 : 0 };
    }
    if (/SELECT\s+creator_user_id\s+FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ creator_user_id: m.creator_user_id }] : [], rowCount: m ? 1 : 0 };
    }

    // List meetings
    if (/FROM\s+meetings\s+m\s+LEFT\s+JOIN\s+meeting_participants/i.test(s)) {
      const uid = params![0];
      const rows = Array.from(this.meetings.values())
        .filter(
          (m) =>
            m.creator_user_id === uid ||
            this.participants.some(
              (p) => p.meeting_id === m.id && p.owner_user_id === uid && p.left_at == null,
            ),
        )
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .map((m) => ({ ...m }));
      return { rows, rowCount: rows.length };
    }

    // DELETE-soft: UPDATE meetings SET state = 'aborted' ... WHERE id=$1 AND creator_user_id=$2
    // (literal 'aborted' string appears only in the DELETE handler; check before generic PATCH.)
    if (/UPDATE\s+meetings[\s\S]*SET\s+state\s*=\s*'aborted'/i.test(s)) {
      const [id, uid] = params!;
      const m = this.meetings.get(id);
      if (!m || m.creator_user_id !== uid) return { rows: [], rowCount: 0 };
      m.state = "aborted";
      if (m.ended_at == null) m.ended_at = new Date();
      return { rows: [{ id: m.id, state: m.state, ended_at: m.ended_at }], rowCount: 1 };
    }

    // UPDATE meetings ... RETURNING (PATCH)
    if (/^UPDATE\s+meetings\s+SET/i.test(s) && /RETURNING/i.test(s)) {
      const id = params![params!.length - 1];
      const m = this.meetings.get(id);
      if (!m) return { rows: [], rowCount: 0 };
      let idx = 0;
      const setClauses = s
        .slice(s.indexOf("SET") + 3, s.indexOf("WHERE"))
        .split(",")
        .map((c) => c.trim());
      for (const clause of setClauses) {
        if (clause.startsWith("state")) {
          m.state = params![idx++];
        } else if (clause.startsWith("metadata")) {
          m.metadata = JSON.parse(params![idx++]);
        } else if (clause.startsWith("ended_at")) {
          if (m.ended_at == null) m.ended_at = new Date();
        }
      }
      return { rows: [{ ...m }], rowCount: 1 };
    }

    // Participants list for a meeting
    if (/FROM\s+meeting_participants\s+WHERE\s+meeting_id\s*=\s*\$1\s+ORDER\s+BY\s+joined_at/i.test(s)) {
      const id = params![0];
      const rows = this.participants.filter((p) => p.meeting_id === id).map((p) => ({ ...p }));
      return { rows, rowCount: rows.length };
    }

    // Active-participant-owner check (for context append authz / scope discovery)
    if (/SELECT\s+1\s+FROM\s+meeting_participants\s+WHERE\s+meeting_id\s*=\s*\$1\s+AND\s+owner_user_id\s*=\s*\$2/i.test(s)) {
      const [id, uid] = params!;
      const ok = this.participants.some(
        (p) => p.meeting_id === id && p.owner_user_id === uid && p.left_at == null,
      );
      return { rows: ok ? [{ "?column?": 1 }] : [], rowCount: ok ? 1 : 0 };
    }

    // Distinct participant agent ids owned by caller
    if (/SELECT\s+DISTINCT\s+mp\.agent_id[\s\S]*FROM\s+meeting_participants/i.test(s)) {
      const [id, uid] = params!;
      const ids = Array.from(
        new Set(
          this.participants
            .filter((p) => p.meeting_id === id && p.owner_user_id === uid && p.left_at == null)
            .map((p) => p.agent_id),
        ),
      ).map((agent_id) => ({ agent_id }));
      return { rows: ids, rowCount: ids.length };
    }

    // userCanReadMeeting (SELECT 1 FROM meetings m WHERE m.id = $1 AND ...)
    if (/FROM\s+meetings\s+m\s+WHERE\s+m\.id\s*=\s*\$1/i.test(s) && /EXISTS/i.test(s)) {
      const [id, uid] = params!;
      const m = this.meetings.get(id);
      if (!m) return { rows: [], rowCount: 0 };
      const ok =
        m.creator_user_id === uid ||
        this.participants.some(
          (p) => p.meeting_id === id && p.owner_user_id === uid && p.left_at == null,
        );
      return { rows: ok ? [{ "?column?": 1 }] : [], rowCount: ok ? 1 : 0 };
    }

    // INSERT INTO meeting_participants
    if (/INSERT\s+INTO\s+meeting_participants/i.test(s)) {
      const [meeting_id, agent_id, owner_user_id, participation_mode] = params!;
      const active = this.participants.find(
        (p) => p.meeting_id === meeting_id && p.agent_id === agent_id && p.left_at == null,
      );
      if (active) {
        const err: any = new Error("duplicate key value violates unique constraint \"uniq_mp_active\"");
        err.code = "23505";
        throw err;
      }
      const p: Participant = {
        id: randomUUID(),
        meeting_id,
        agent_id,
        owner_user_id,
        participation_mode,
        joined_at: new Date(),
        left_at: null,
      };
      this.participants.push(p);
      return { rows: [{ ...p }], rowCount: 1 };
    }

    // MAX(sequence_number)+1
    if (/COALESCE\(MAX\(sequence_number\),\s*0\)\s*\+\s*1/i.test(s)) {
      const id = params![0];
      const max = this.context
        .filter((c) => c.meeting_id === id)
        .reduce((acc, c) => Math.max(acc, c.sequence_number), 0);
      return { rows: [{ next_seq: max + 1 }], rowCount: 1 };
    }

    // INSERT INTO meeting_context
    if (/INSERT\s+INTO\s+meeting_context/i.test(s)) {
      const [meeting_id, sequence_number, content, author_agent_id, visibility, scopeJson] = params!;
      // enforce uniq_mc_sequence
      if (this.context.some((c) => c.meeting_id === meeting_id && c.sequence_number === sequence_number)) {
        const err: any = new Error("duplicate key value violates unique constraint \"uniq_mc_sequence\"");
        err.code = "23505";
        throw err;
      }
      const row: ContextRow = {
        id: randomUUID(),
        meeting_id,
        sequence_number,
        content,
        author_agent_id: author_agent_id ?? null,
        visibility,
        scope_agent_ids: JSON.parse(scopeJson),
        created_at: new Date(),
      };
      this.context.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // GET context list
    if (/FROM\s+meeting_context/i.test(s) && /ORDER\s+BY\s+sequence_number/i.test(s)) {
      const meeting_id = params![0];
      // meetings.ts pushes: [id, (afterSeq?), (ownedAgentIdsJson?), limit]
      // We parse positions by counting known tokens.
      let pIdx = 1;
      let afterSeq = 0;
      if (/sequence_number\s*>\s*\$2/i.test(s)) {
        afterSeq = params![pIdx++];
      }
      let ownedAgentIds: number[] | null = null;
      if (/jsonb_array_elements_text\(\$(\d+)::jsonb\)/i.test(s)) {
        ownedAgentIds = JSON.parse(params![pIdx++]);
      }
      // last param is limit (we ignore for simplicity — tests never overflow)
      const isCreator = /visibility\s*=\s*'owner'/i.test(s);

      const filtered = this.context
        .filter((c) => c.meeting_id === meeting_id)
        .filter((c) => c.sequence_number > afterSeq)
        .filter((c) => {
          if (c.visibility === "all") return true;
          if (c.visibility === "owner") return isCreator;
          if (c.visibility === "scoped") {
            if (isCreator) return true;
            if (ownedAgentIds && ownedAgentIds.some((aid) => c.scope_agent_ids.includes(aid))) return true;
            return false;
          }
          return false;
        })
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .map((c) => ({ ...c }));
      return { rows: filtered, rowCount: filtered.length };
    }

    throw new Error(`FakePg: unhandled SQL: ${s.slice(0, 120)}…`);
  }
}

// Lazily construct FakePg inside hoisted so vi.mock sees it (vi.hoisted runs
// before module imports). We assign to a holder so the mock factory (itself
// hoisted) can reach it through the holder object.
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

holder.fake = new FakePg();
const fake = holder.fake as FakePg;
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));

// Import after mocks.
import express from "express";
import request from "supertest";
import { registerMeetingRoutes } from "../routes/meetings";

function makeApp(userId: number | null = 1) {
  const app = express();
  app.use(express.json());
  registerMeetingRoutes(app, async () => userId);
  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Meeting Room API", () => {
  beforeEach(() => {
    fake.reset();
    fake.rooms.set(10, { id: 10, user_id: 1 });
    fake.rooms.set(20, { id: 20, user_id: 2 });
    fake.agents.set(100, { id: 100, user_id: 1 });
    fake.agents.set(101, { id: 101, user_id: 1 });
    fake.agents.set(200, { id: 200, user_id: 2 });
  });

  it("POST /api/meetings — 201 on valid payload w/ participants", async () => {
    const app = makeApp(1);
    const res = await request(app)
      .post("/api/meetings")
      .send({ room_id: 10, metadata: { title: "test" }, participants: [{ agent_id: 100 }] });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/-/);
    expect(res.body.participants).toHaveLength(1);
    expect(res.body.state).toBe("pending");
  });

  it("POST /api/meetings — 403 when room owned by another user", async () => {
    const app = makeApp(1);
    const res = await request(app).post("/api/meetings").send({ room_id: 20 });
    expect(res.status).toBe(403);
  });

  it("POST /api/meetings — 404 when room doesn't exist", async () => {
    const app = makeApp(1);
    const res = await request(app).post("/api/meetings").send({ room_id: 999 });
    expect(res.status).toBe(404);
  });

  it("POST /api/meetings — 400 when participant agent not owned", async () => {
    const app = makeApp(1);
    const res = await request(app)
      .post("/api/meetings")
      .send({ room_id: 10, participants: [{ agent_id: 200 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("agent_not_owned");
  });

  it("GET /api/meetings/:id — 200 for creator", async () => {
    const app = makeApp(1);
    const c = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = c.body.id;
    const get = await request(app).get(`/api/meetings/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(id);
  });

  it("GET /api/meetings/:id — 400 on non-UUID", async () => {
    const app = makeApp(1);
    const res = await request(app).get("/api/meetings/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("GET /api/meetings/:id — 404 when neither creator nor participant", async () => {
    const appUser1 = makeApp(1);
    const created = await request(appUser1).post("/api/meetings").send({ room_id: 10 });
    const id = created.body.id;

    const appUser2 = makeApp(2);
    const res = await request(appUser2).get(`/api/meetings/${id}`);
    expect(res.status).toBe(404);
  });

  it("PATCH /api/meetings/:id — pending → active ok; pending → completed rejected", async () => {
    const app = makeApp(1);
    const created = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = created.body.id;

    const ok = await request(app).patch(`/api/meetings/${id}`).send({ state: "active" });
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("active");

    const bad = await request(app).patch(`/api/meetings/${id}`).send({ state: "pending" });
    expect(bad.status).toBe(400);
  });

  it("PATCH /api/meetings/:id — terminal → anything rejected", async () => {
    const app = makeApp(1);
    const created = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = created.body.id;
    await request(app).patch(`/api/meetings/${id}`).send({ state: "active" });
    await request(app).patch(`/api/meetings/${id}`).send({ state: "completed" });
    const bad = await request(app).patch(`/api/meetings/${id}`).send({ state: "active" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("meeting_terminal");
  });

  it("PATCH /api/meetings/:id — active → aborted sets ended_at", async () => {
    const app = makeApp(1);
    const created = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = created.body.id;
    await request(app).patch(`/api/meetings/${id}`).send({ state: "active" });
    const res = await request(app).patch(`/api/meetings/${id}`).send({ state: "aborted" });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("aborted");
    expect(res.body.ended_at).toBeTruthy();
  });

  it("DELETE /api/meetings/:id — soft delete, non-creator 404", async () => {
    const app1 = makeApp(1);
    const created = await request(app1).post("/api/meetings").send({ room_id: 10 });
    const id = created.body.id;

    const app2 = makeApp(2);
    const res2 = await request(app2).delete(`/api/meetings/${id}`);
    expect(res2.status).toBe(404);

    const res1 = await request(app1).delete(`/api/meetings/${id}`);
    expect(res1.status).toBe(200);
    expect(res1.body.state).toBe("aborted");
    expect(res1.body.ended_at).toBeTruthy();
  });

  it("POST /api/meetings/:id/context — seq numbers 1,2,3 on sequential", async () => {
    const app = makeApp(1);
    const c = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = c.body.id;

    const r1 = await request(app).post(`/api/meetings/${id}/context`).send({ content: "a" });
    const r2 = await request(app).post(`/api/meetings/${id}/context`).send({ content: "b" });
    const r3 = await request(app).post(`/api/meetings/${id}/context`).send({ content: "c" });
    expect([r1.status, r2.status, r3.status]).toEqual([201, 201, 201]);
    expect([r1.body.sequence_number, r2.body.sequence_number, r3.body.sequence_number]).toEqual([
      1, 2, 3,
    ]);
  });

  it("POST /api/meetings/:id/context — 10 concurrent inserts produce unique seq (N1 fix)", async () => {
    const app = makeApp(1);
    const c = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = c.body.id;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request(app).post(`/api/meetings/${id}/context`).send({ content: `m${i}` }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);
    const seqs = results.map((r) => r.body.sequence_number).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("POST /api/meetings/:id/context — 400 meeting_terminal on completed/aborted", async () => {
    const app = makeApp(1);
    const c = await request(app).post("/api/meetings").send({ room_id: 10 });
    const id = c.body.id;
    await request(app).patch(`/api/meetings/${id}`).send({ state: "active" });
    await request(app).patch(`/api/meetings/${id}`).send({ state: "completed" });
    const res = await request(app).post(`/api/meetings/${id}/context`).send({ content: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("meeting_terminal");
  });

  it("POST /api/meetings/:id/context — 404 non-existent meeting", async () => {
    const app = makeApp(1);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/context`).send({ content: "x" });
    expect(res.status).toBe(404);
  });

  it("POST /api/meetings/:id/context — 400 when visibility=scoped without scope_agent_ids", async () => {
    const app = makeApp(1);
    const c = await request(app).post("/api/meetings").send({ room_id: 10 });
    const res = await request(app)
      .post(`/api/meetings/${c.body.id}/context`)
      .send({ content: "x", visibility: "scoped" });
    expect(res.status).toBe(400);
  });

  it("GET /api/meetings/:id/context — visibility filter: owner hidden from non-creator participant", async () => {
    const app1 = makeApp(1);
    const c = await request(app1).post("/api/meetings").send({
      room_id: 10,
      participants: [{ agent_id: 100 }],
    });
    const id = c.body.id;

    // Insert owner-visibility entry as user 1.
    await request(app1).post(`/api/meetings/${id}/context`).send({ content: "secret", visibility: "owner" });
    await request(app1).post(`/api/meetings/${id}/context`).send({ content: "public", visibility: "all" });

    // user 1 (creator) sees both
    const r1 = await request(app1).get(`/api/meetings/${id}/context`);
    expect(r1.body.context).toHaveLength(2);

    // user 2 with their own agent added
    fake.agents.set(300, { id: 300, user_id: 2 });
    fake.participants.push({
      id: randomUUID(),
      meeting_id: id,
      agent_id: 300,
      owner_user_id: 2,
      participation_mode: "observe",
      joined_at: new Date(),
      left_at: null,
    });
    const app2 = makeApp(2);
    const r2 = await request(app2).get(`/api/meetings/${id}/context`);
    expect(r2.status).toBe(200);
    // user 2 sees only the 'all' entry
    expect(r2.body.context).toHaveLength(1);
    expect(r2.body.context[0].visibility).toBe("all");
  });
});

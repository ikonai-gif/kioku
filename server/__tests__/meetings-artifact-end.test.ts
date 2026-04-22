/**
 * Tests for POST /api/meetings/:id/artifact + /end (W9 Item 5).
 *
 * Focus: privacy invariant "meeting context NEVER becomes personal memory
 * unless carry_over_memory=true", artifact versioning, end idempotency.
 *
 * Strategy: in-memory fake pg that reproduces exactly the subset of
 * statements the two endpoints issue, plus a stub for storage.createMemory
 * so we can count writes without touching the real memories table.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";

// ── pg fake ─────────────────────────────────────────────────────────────────
type Meeting = { id: string; creator_user_id: number; state: string };
type Participant = {
  id: string;
  meeting_id: string;
  agent_id: number;
  owner_user_id: number;
  carry_over_memory: boolean;
  left_at: Date | null;
};
type ContextRow = {
  id: string;
  meeting_id: string;
  sequence_number: number;
  author_agent_id: number | null;
  content: string;
};
type Artifact = {
  id: string;
  meeting_id: string;
  type: string;
  content: any;
  version: number;
  created_by_agent_id: number | null;
  created_at: Date;
  updated_at: Date;
};

class ArtifactFakePg {
  meetings = new Map<string, Meeting>();
  participants: Participant[] = [];
  context: ContextRow[] = [];
  artifacts: Artifact[] = [];

  reset() {
    this.meetings.clear();
    this.participants = [];
    this.context = [];
    this.artifacts = [];
  }

  async query(sql: string, params?: any[]) {
    return this.runQuery(sql, params);
  }

  connect() {
    const db = this;
    return Promise.resolve({
      query: (sql: string, params?: any[]) => db.runQuery(sql, params),
      release: () => {},
    });
  }

  private async runQuery(sql: string, params: any[] | undefined): Promise<{ rows: any[]; rowCount: number }> {
    const s = sql.trim();
    if (/^BEGIN\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^COMMIT\b/i.test(s)) return { rows: [], rowCount: 0 };
    if (/^ROLLBACK\b/i.test(s)) return { rows: [], rowCount: 0 };

    // /artifact: SELECT creator_user_id, state FROM meetings WHERE id=$1 FOR UPDATE
    // /end  pre-check: SELECT creator_user_id, state FROM meetings WHERE id=$1
    if (/SELECT\s+creator_user_id,\s*state\s+FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ creator_user_id: m.creator_user_id, state: m.state }] : [], rowCount: m ? 1 : 0 };
    }

    // end phase-1: SELECT id, state FROM meetings WHERE id=$1 FOR UPDATE
    if (/SELECT\s+id,\s*state\s+FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ id: m.id, state: m.state }] : [], rowCount: m ? 1 : 0 };
    }

    // upsertArtifact: SELECT 1 FROM meetings WHERE id=$1 FOR UPDATE (lock)
    if (/SELECT\s+1\s+FROM\s+meetings\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i.test(s)) {
      const m = this.meetings.get(params![0]);
      return { rows: m ? [{ "?column?": 1 }] : [], rowCount: m ? 1 : 0 };
    }

    // upsertArtifact: SELECT COALESCE(MAX(version), 0) AS max_version FROM meeting_artifacts WHERE meeting_id=$1 AND type=$2
    if (/SELECT\s+COALESCE\(MAX\(version\),\s*0\)\s+AS\s+max_version\s+FROM\s+meeting_artifacts/i.test(s)) {
      const [mid, type] = params!;
      const max = this.artifacts
        .filter((a) => a.meeting_id === mid && a.type === type)
        .reduce((acc, a) => Math.max(acc, a.version), 0);
      return { rows: [{ max_version: max }], rowCount: 1 };
    }

    // upsertArtifact: INSERT INTO meeting_artifacts ... RETURNING ...
    if (/INSERT\s+INTO\s+meeting_artifacts/i.test(s)) {
      const [meeting_id, type, contentJson, version, created_by_agent_id] = params!;
      const now = new Date();
      const row: Artifact = {
        id: randomUUID(),
        meeting_id,
        type,
        content: JSON.parse(contentJson),
        version,
        created_by_agent_id,
        created_at: now,
        updated_at: now,
      };
      this.artifacts.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // end phase-1: SELECT id, agent_id, owner_user_id, carry_over_memory FROM meeting_participants WHERE meeting_id=$1 AND left_at IS NULL
    if (/SELECT\s+id,\s*agent_id,\s*owner_user_id,\s*carry_over_memory\s+FROM\s+meeting_participants/i.test(s)) {
      const [mid] = params!;
      const rows = this.participants
        .filter((p) => p.meeting_id === mid && p.left_at === null)
        .map((p) => ({
          id: p.id,
          agent_id: p.agent_id,
          owner_user_id: p.owner_user_id,
          carry_over_memory: p.carry_over_memory,
        }));
      return { rows, rowCount: rows.length };
    }

    // end phase-1: SELECT sequence_number, author_agent_id, content FROM meeting_context WHERE meeting_id=$1 ORDER BY sequence_number ASC LIMIT 500
    if (/SELECT\s+sequence_number,\s*author_agent_id,\s*content\s+FROM\s+meeting_context/i.test(s)) {
      const [mid] = params!;
      const rows = this.context
        .filter((c) => c.meeting_id === mid)
        .sort((a, b) => a.sequence_number - b.sequence_number)
        .map((c) => ({
          sequence_number: c.sequence_number,
          author_agent_id: c.author_agent_id,
          content: c.content,
        }));
      return { rows, rowCount: rows.length };
    }

    // end phase-1: UPDATE meetings SET state='completed', updated_at=NOW() WHERE id=$1
    if (/UPDATE\s+meetings\s+SET\s+state\s*=\s*'completed'/i.test(s)) {
      const [id] = params!;
      const m = this.meetings.get(id);
      if (m) m.state = "completed";
      return { rows: [], rowCount: m ? 1 : 0 };
    }

    throw new Error(`ArtifactFakePg: unhandled SQL: ${s.slice(0, 200)}`);
  }
}

const holder = vi.hoisted(() => ({ fake: null as any, createdMemories: [] as any[] }));
vi.mock("pg", () => {
  function MockPool(this: any) {
    this.query = (...a: any[]) => holder.fake.query(...a);
    this.connect = () => holder.fake.connect();
    this.on = () => {};
    this.end = () => Promise.resolve();
  }
  return { Pool: MockPool };
});
holder.fake = new ArtifactFakePg();
const fake = holder.fake as ArtifactFakePg;

vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({}) }));

// Mock storage.createMemory so the end path records writes without hitting a real DB.
// Use the mocked `pg` (above) by requiring via dynamic import so vi's module
// registry has already applied the `pg` mock before this module resolves.
vi.mock("../storage", async () => {
  const pg: any = await import("pg");
  return {
    pool: new pg.Pool(),
    storage: {
      createMemory: vi.fn(async (data: any) => {
        const row = { id: holder.createdMemories.length + 1, ...data, created_at: Date.now() };
        holder.createdMemories.push(row);
        return row;
      }),
    },
  };
});

import express from "express";
import request from "supertest";
import { registerMeetingRoutes } from "../routes/meetings";
import { RecordingMeetingEventBus } from "../lib/meeting-event-bus";
import { meetingSummaryNamespace } from "../lib/meeting-artifact";

function makeApp(userId: number | null, summarizer?: any) {
  const app = express();
  app.use(express.json());
  const eventBus = new RecordingMeetingEventBus();
  const llmFactory = async () => async () => ({ content: "ok", visibility: "all" as const });
  registerMeetingRoutes(app, async () => userId, {
    eventBus,
    llmFactory,
    summarizer: summarizer ?? (async ({ transcript }: any) => `summary: ${transcript.slice(0, 40)}`),
  });
  // Test-only error surface: without this, express default handler swallows
  // the response body and we only see 500 with no diagnostic.
  app.use((err: any, _req: any, res: any, _next: any) => {
    // eslint-disable-next-line no-console
    console.error("[test error mw]", err?.message, err?.stack?.split("\n").slice(0, 3).join(" | "));
    res.status(500).json({ error: String(err?.message ?? err) });
  });
  return { app, eventBus };
}

function seedMeeting(opts: {
  creator?: number;
  state?: string;
  participants?: Array<{ agentId: number; ownerUserId: number; carryOver: boolean }>;
  contextEntries?: Array<{ agentId: number | null; content: string }>;
}) {
  const mid = randomUUID();
  fake.meetings.set(mid, {
    id: mid,
    creator_user_id: opts.creator ?? 1,
    state: opts.state ?? "active",
  });
  (opts.participants ?? []).forEach((p) => {
    fake.participants.push({
      id: randomUUID(),
      meeting_id: mid,
      agent_id: p.agentId,
      owner_user_id: p.ownerUserId,
      carry_over_memory: p.carryOver,
      left_at: null,
    });
  });
  (opts.contextEntries ?? []).forEach((c, i) => {
    fake.context.push({
      id: randomUUID(),
      meeting_id: mid,
      sequence_number: i + 1,
      author_agent_id: c.agentId,
      content: c.content,
    });
  });
  return mid;
}

beforeEach(() => {
  fake.reset();
  holder.createdMemories.length = 0;
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
// POST /artifact
// ───────────────────────────────────────────────────────────────────────────

describe("POST /api/meetings/:id/artifact", () => {
  it("401 when unauthenticated", async () => {
    const { app } = makeApp(null);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/artifact`).send({ type: "deliberation", content: {} });
    expect(res.status).toBe(401);
  });

  it("400 on invalid meeting id", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/not-a-uuid/artifact`).send({ type: "t", content: {} });
    expect(res.status).toBe(400);
  });

  it("400 on missing body fields", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/artifact`).send({});
    expect(res.status).toBe(400);
  });

  it("404 when meeting not found", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/artifact`).send({ type: "t", content: {} });
    expect(res.status).toBe(404);
  });

  it("403 when caller is not creator", async () => {
    const { app } = makeApp(2);
    const mid = seedMeeting({ creator: 1 });
    const res = await request(app).post(`/api/meetings/${mid}/artifact`).send({ type: "t", content: {} });
    expect(res.status).toBe(403);
  });

  it("400 meeting_terminal when meeting already completed", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({ creator: 1, state: "completed" });
    const res = await request(app).post(`/api/meetings/${mid}/artifact`).send({ type: "t", content: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("meeting_terminal");
  });

  it("happy path: creates v1", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({ creator: 1 });
    const res = await request(app)
      .post(`/api/meetings/${mid}/artifact`)
      .send({ type: "deliberation", content: { summary: "hello" }, created_by_agent_id: 100 });
    expect(res.status).toBe(201);
    expect(res.body.artifact.version).toBe(1);
    expect(res.body.artifact.type).toBe("deliberation");
    expect(fake.artifacts).toHaveLength(1);
    expect(fake.artifacts[0].created_by_agent_id).toBe(100);
  });

  it("version bumps monotonically: v1 → v2 → v3 per (meeting,type)", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({ creator: 1 });
    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post(`/api/meetings/${mid}/artifact`)
        .send({ type: "deliberation", content: { n: i } });
      expect(res.status).toBe(201);
      expect(res.body.artifact.version).toBe(i);
    }
    expect(fake.artifacts.map((a) => a.version)).toEqual([1, 2, 3]);
  });

  it("different types have independent version sequences", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({ creator: 1 });
    const a = await request(app).post(`/api/meetings/${mid}/artifact`).send({ type: "deliberation", content: {} });
    const b = await request(app).post(`/api/meetings/${mid}/artifact`).send({ type: "decision", content: {} });
    expect(a.body.artifact.version).toBe(1);
    expect(b.body.artifact.version).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /end — privacy invariant is the whole game
// ───────────────────────────────────────────────────────────────────────────

describe("POST /api/meetings/:id/end", () => {
  it("401 when unauthenticated", async () => {
    const { app } = makeApp(null);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/end`).send({});
    expect(res.status).toBe(401);
  });

  it("404 when meeting not found", async () => {
    const { app } = makeApp(1);
    const res = await request(app).post(`/api/meetings/${randomUUID()}/end`).send({});
    expect(res.status).toBe(404);
  });

  it("403 when caller is not creator", async () => {
    const { app } = makeApp(2);
    const mid = seedMeeting({ creator: 1 });
    const res = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(res.status).toBe(403);
  });

  it("PRIVACY: both participants carry_over=false → zero memory writes", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({
      creator: 1,
      participants: [
        { agentId: 100, ownerUserId: 1, carryOver: false },
        { agentId: 101, ownerUserId: 2, carryOver: false },
      ],
      contextEntries: [
        { agentId: 100, content: "hello from A" },
        { agentId: 101, content: "hello from B" },
        { agentId: 100, content: "bye from A" },
      ],
    });
    const res = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      meeting_id: mid,
      state: "completed",
      memories_written: 0,
      participants_opted_in: 0,
    });
    expect(holder.createdMemories).toHaveLength(0);
    expect(fake.meetings.get(mid)!.state).toBe("completed");
  });

  it("OPT-IN: exactly 1 memory per opt-in participant, namespace=_meeting_summary_{id}, belongs to that user", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({
      creator: 1,
      participants: [
        { agentId: 100, ownerUserId: 1, carryOver: true },
        { agentId: 101, ownerUserId: 2, carryOver: false },
      ],
      contextEntries: [{ agentId: 100, content: "decision text" }],
    });
    const res = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(res.status).toBe(200);
    expect(res.body.memories_written).toBe(1);
    expect(res.body.participants_opted_in).toBe(1);
    expect(holder.createdMemories).toHaveLength(1);
    const mem = holder.createdMemories[0];
    expect(mem.userId).toBe(1);                             // opt-in user only
    expect(mem.agentId).toBe(100);
    expect(mem.namespace).toBe(meetingSummaryNamespace(mid));
    expect(mem.importance).toBe(0.4);
    expect(mem.type).toBe("episodic");
    expect(mem.content).toMatch(/summary:/);                 // our injected summarizer
  });

  it("summarizer failure → fallback memory still written for opt-in", async () => {
    const failingSummarizer = vi.fn(async () => {
      throw new Error("boom");
    });
    const { app } = makeApp(1, failingSummarizer);
    const mid = seedMeeting({
      creator: 1,
      participants: [{ agentId: 100, ownerUserId: 1, carryOver: true }],
      contextEntries: [{ agentId: 100, content: "x" }],
    });
    const res = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(res.status).toBe(200);
    expect(res.body.memories_written).toBe(1);
    expect(holder.createdMemories[0].content).toBe("[meeting summary unavailable]");
    expect(failingSummarizer).toHaveBeenCalledOnce();
  });

  it("409 on second /end call (already completed)", async () => {
    const { app } = makeApp(1);
    const mid = seedMeeting({
      creator: 1,
      participants: [{ agentId: 100, ownerUserId: 1, carryOver: false }],
    });
    const first = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("meeting_terminal");
    expect(second.body.state).toBe("completed");
  });

  it("emits meeting.ended event with no content/contentPreview (F1)", async () => {
    const { app, eventBus } = makeApp(1);
    const mid = seedMeeting({
      creator: 1,
      participants: [{ agentId: 100, ownerUserId: 1, carryOver: false }],
      contextEntries: [{ agentId: 100, content: "secret meeting text that must not leak via event" }],
    });
    const res = await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(eventBus.events).toHaveLength(1);
    const ev = eventBus.events[0];
    expect(ev.event).toBe("meeting.ended");
    expect(ev.payload.meetingId).toBe(mid);
    expect(ev.payload.state).toBe("completed");
    expect((ev.payload as any).content).toBeUndefined();
    expect((ev.payload as any).contentPreview).toBeUndefined();
    expect(JSON.stringify(ev.payload)).not.toContain("secret meeting text");
  });

  it("summarizer receives transcript built from context rows", async () => {
    const captured: any[] = [];
    const spySummarizer = async (args: any) => {
      captured.push(args);
      return "ok";
    };
    const { app } = makeApp(1, spySummarizer);
    const mid = seedMeeting({
      creator: 1,
      participants: [{ agentId: 100, ownerUserId: 1, carryOver: true }],
      contextEntries: [
        { agentId: 100, content: "first" },
        { agentId: 101, content: "second" },
      ],
    });
    await request(app).post(`/api/meetings/${mid}/end`).send({});
    expect(captured).toHaveLength(1);
    expect(captured[0].meetingId).toBe(mid);
    expect(captured[0].transcript).toContain("first");
    expect(captured[0].transcript).toContain("second");
    expect(captured[0].transcript).toMatch(/seq 1/);
  });
});

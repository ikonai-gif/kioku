/**
 * Integration test — real Postgres (via Testcontainers) + Meeting Room routes.
 *
 * The W5 N1 fix added `SELECT … FROM meetings WHERE id=$1 FOR UPDATE`
 * in POST /api/meetings/:id/context before computing `MAX(sequence_number)+1`.
 * Unit tests run against a FakePg that doesn't emulate MVCC/row locks, so we
 * need a real Postgres to actually verify the lock serializes concurrent
 * appenders and that terminal-state transitions race safely with in-flight
 * writes.
 *
 * Three cases:
 *   1. 50 concurrent appends → unique contiguous sequence_numbers (1..50).
 *   2. DELETE during concurrent appends → appends scheduled before the
 *      DELETE's FOR UPDATE acquire succeed (201); those after see the new
 *      terminal state and get 400 meeting_terminal. No partial state.
 *   3. 10 concurrent `add_participant` calls for the same agent → exactly
 *      one 201; the rest hit the uniq_mp_active unique index (409).
 *
 * Container: postgres:16-alpine. Migrations applied in order from the
 * hardcoded list — we intentionally avoid `readdirSync` so the *_down.sql
 * files never get picked up.
 */

import { vi, describe, test, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";
import request from "supertest";
import type { Express } from "express";

// Hoisted holder so the vi.mock factory (which runs before regular imports)
// can reach the testPool we build in beforeAll.
const holder = vi.hoisted(() => ({ pool: null as Pool | null }));

// storage.ts is where `pool` is exported from (server/routes/meetings.ts does
// `import { pool } from "../storage"`). The brief assumed a `../db` module —
// that doesn't exist in this repo, so we mock "../storage" here instead with
// a lazy getter so callers always see the live testPool.
vi.mock("../storage", async () => {
  const actual = await vi.importActual<typeof import("../storage")>("../storage");
  return {
    ...actual,
    get pool() {
      if (!holder.pool) {
        throw new Error("integration test: testPool not initialized yet");
      }
      return holder.pool;
    },
  };
});

let container: StartedPostgreSqlContainer;
let testPool: Pool;
let app: Express;

/**
 * Seed a user (+api_key), a room owned by that user, and an agent owned by
 * that user. Returns the trio of ids. Called fresh for every test so each
 * test works on its own sandbox.
 */
async function seedOwner(pool: Pool): Promise<{ userId: number; roomId: number; agentId: number }> {
  const now = Date.now();
  const { rows: uRows } = await pool.query(
    `INSERT INTO users (email, name, api_key, created_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [`u${now}-${Math.random()}@test.local`, "Test User", `kk_test_${now}_${Math.random()}`, now],
  );
  const userId = uRows[0].id as number;
  const { rows: rRows } = await pool.query(
    `INSERT INTO rooms (user_id, name, created_at) VALUES ($1, $2, $3) RETURNING id`,
    [userId, "Integration Room", now],
  );
  const roomId = rRows[0].id as number;
  // agents table has no updated_at column in migrations 0000/0001 — only created_at.
  // Pre-existing bug from Week 6 Item 3 (#5), hidden for weeks because paths-filter
  // skipped this test unless migrations/** or schema.ts changed. Surfaced on W7 P2.3
  // because migration 0002 triggers the filter. Fix: drop updated_at from INSERT.
  const { rows: aRows } = await pool.query(
    `INSERT INTO agents (user_id, name, created_at)
     VALUES ($1, $2, $3) RETURNING id`,
    [userId, "Integration Agent", now],
  );
  const agentId = aRows[0].id as number;
  return { userId, roomId, agentId };
}

describe("Meeting Room — PG concurrency (integration)", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    // max: 50 — this suite fans 50 concurrent POSTs at a single meeting row.
    // pg-Pool's default max=10 starves the server handler under that burst.
    // Production `pool` in server/storage.ts uses max=20; here we size for the
    // test's synthetic worst case so we're measuring app correctness, not
    // acquire-queue timeouts.
    testPool = new Pool({ connectionString: container.getConnectionUri(), max: 50 });
    holder.pool = testPool;

    // Hardcoded migration list (plan v2.1 decision). Using readdirSync would
    // accidentally pick up *_down.sql files and drop the very tables we just
    // created — don't do that.
    const migrationFiles = [
      "0000_narrow_harpoon.sql",
      "0001_meeting_room_schema.sql",
    ];
    for (const f of migrationFiles) {
      // Drizzle emits `--> statement-breakpoint` markers we need to honor to
      // avoid pg.Client complaining about multi-statement txns in odd cases.
      const raw = readFileSync(join(__dirname, "..", "..", "migrations", f), "utf-8");
      const statements = raw
        .split(/--> statement-breakpoint/g)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await testPool.query(stmt);
      }
    }

    // Each test seeds its own user+room+agent, so createApp gets a getUser
    // that trusts the `x-test-user` header the tests set per-request. That
    // keeps us away from the real auth stack (cookies, JWT, session).
    const { createApp } = await import("../app");
    app = await createApp({
      getUser: async (req) => {
        const header = (req.headers["x-test-user"] as string) || "";
        const id = parseInt(header, 10);
        return Number.isFinite(id) && id > 0 ? id : null;
      },
    });
  }, 120_000);

  afterAll(async () => {
    await testPool?.end();
    await container?.stop();
  });

  test("50 concurrent POST /context — unique contiguous sequence_numbers", async () => {
    const { userId, roomId } = await seedOwner(testPool);
    const createRes = await request(app)
      .post("/api/meetings")
      .set("x-test-user", String(userId))
      .send({ room_id: roomId });
    expect(createRes.status).toBe(201);
    const meetingId = createRes.body.id as string;

    // Fan out 50 parallel POSTs.
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post(`/api/meetings/${meetingId}/context`)
          .set("x-test-user", String(userId))
          .send({ content: `msg-${i}` }),
      ),
    );
    // Diagnose any non-201 up-front so the failure message is actionable
    // (rather than showing a mysterious short array in the seq assertion).
    const nonOk = results.filter((r) => r.status !== 201);
    if (nonOk.length > 0) {
      const summary = nonOk.slice(0, 3).map((r) => ({ status: r.status, body: r.body }));
      throw new Error(
        `${nonOk.length}/${N} POST /context did not return 201. First 3: ${JSON.stringify(summary)}`,
      );
    }

    // sequence_number comes back as bigint string from pg; coerce to number
    // so deep-equal against Array(1..N) succeeds (W7 P2.3 integration debug).
    const seqs = results
      .map((r) => Number(r.body.sequence_number))
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    // Belt-and-suspenders: DB agrees.
    const { rows } = await testPool.query(
      "SELECT sequence_number FROM meeting_context WHERE meeting_id = $1 ORDER BY sequence_number",
      [meetingId],
    );
    expect(rows.map((r) => Number(r.sequence_number))).toEqual(seqs);
  });

  test("DELETE during concurrent POST /context — FOR UPDATE serializes, no partial state", async () => {
    const { userId, roomId } = await seedOwner(testPool);
    const createRes = await request(app)
      .post("/api/meetings")
      .set("x-test-user", String(userId))
      .send({ room_id: roomId });
    expect(createRes.status).toBe(201);
    const meetingId = createRes.body.id as string;

    // Interleave: fire 20 POSTs, then immediately fire DELETE, then fire 20
    // more POSTs. FOR UPDATE on the meetings row serializes all of them on
    // the same tuple. Post-DELETE writers must observe state='aborted' and
    // bounce with 400 meeting_terminal.
    const before = Array.from({ length: 20 }, (_, i) =>
      request(app)
        .post(`/api/meetings/${meetingId}/context`)
        .set("x-test-user", String(userId))
        .send({ content: `before-${i}` }),
    );
    const del = request(app)
      .delete(`/api/meetings/${meetingId}`)
      .set("x-test-user", String(userId));
    const after = Array.from({ length: 20 }, (_, i) =>
      request(app)
        .post(`/api/meetings/${meetingId}/context`)
        .set("x-test-user", String(userId))
        .send({ content: `after-${i}` }),
    );
    const [beforeRes, delRes, afterRes] = await Promise.all([
      Promise.all(before),
      del,
      Promise.all(after),
    ]);

    // DELETE must succeed exactly once (first one wins the FOR UPDATE race;
    // any retried/subsequent delete would see terminal state).
    expect(delRes.status).toBe(200);
    expect(delRes.body.state).toBe("aborted");

    // Every POST is either 201 (landed before DELETE's commit) or 400
    // meeting_terminal (landed after). There must be NO 500s or other
    // statuses — partial/torn state is the failure mode we're guarding.
    const all = [...beforeRes, ...afterRes];
    for (const r of all) {
      expect([201, 400]).toContain(r.status);
      if (r.status === 400) {
        expect(r.body.error).toBe("meeting_terminal");
        expect(r.body.state).toBe("aborted");
      }
    }

    // The ones that succeeded must have unique sequence numbers (1..k).
    const ok = all.filter((r) => r.status === 201);
    // bigint-as-string → number coerce (see note in 50-POST test above).
    const seqs = ok.map((r) => Number(r.body.sequence_number)).sort((a, b) => a - b);
    const expected = Array.from({ length: ok.length }, (_, i) => i + 1);
    expect(seqs).toEqual(expected);

    // DB reflects same count — no ghost rows written after terminal flip.
    const { rows: countRows } = await testPool.query(
      "SELECT COUNT(*)::int AS c FROM meeting_context WHERE meeting_id = $1",
      [meetingId],
    );
    expect(countRows[0].c).toBe(ok.length);
  });

  test("10 concurrent add_participant for same agent → exactly one 201, rest 409", async () => {
    const { userId, roomId, agentId } = await seedOwner(testPool);
    const createRes = await request(app)
      .post("/api/meetings")
      .set("x-test-user", String(userId))
      .send({ room_id: roomId });
    expect(createRes.status).toBe(201);
    const meetingId = createRes.body.id as string;

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        request(app)
          .post(`/api/meetings/${meetingId}/participants`)
          .set("x-test-user", String(userId))
          .send({ agent_id: agentId, participation_mode: "approve" }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);
    for (const r of conflicts) expect(r.body.error).toBe("participant_exists");

    // Exactly one active participant row exists (uniq_mp_active invariant).
    const { rows } = await testPool.query(
      `SELECT COUNT(*)::int AS c FROM meeting_participants
        WHERE meeting_id = $1 AND agent_id = $2 AND left_at IS NULL`,
      [meetingId, agentId],
    );
    expect(rows[0].c).toBe(1);
  });
});

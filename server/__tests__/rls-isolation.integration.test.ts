/**
 * [LUCA-086] RLS Phase 1 — real-Postgres isolation acceptance.
 *
 * Proves on a live testcontainer:
 *  1. A wrapped session (set_config app.user_id) sees ONLY that user rows —
 *     even with no WHERE clause (pure RLS, not the app filter).
 *  2. A legacy session (GUC unset) still sees everything — the PR1
 *     incremental backdoor (BRO2 fix #5), removed once all call sites wrap.
 *  3. FORCE is active for the table owner: tables are owned by a
 *     non-superuser role (mirrors Neon, where the app role is never
 *     superuser) and the owner connection is still policy-bound.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

let container: StartedPostgreSqlContainer;
let adminPool: Pool; // superuser — setup only (superusers always bypass RLS)
let appPool: Pool;   // non-superuser OWNER of the tables — what prod looks like

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test")
    .withUsername("test")
    .withPassword("test")
    .start();

  adminPool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  adminPool.on("error", () => {});

  await adminPool.query("CREATE ROLE app_owner LOGIN PASSWORD $$app$$ NOSUPERUSER");
  await adminPool.query("CREATE TABLE memories (id serial PRIMARY KEY, user_id int NOT NULL, content text)");
  await adminPool.query("CREATE TABLE rooms (id serial PRIMARY KEY, user_id int NOT NULL, name text)");
  await adminPool.query("ALTER TABLE memories OWNER TO app_owner");
  await adminPool.query("ALTER TABLE rooms OWNER TO app_owner");

  appPool = new Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: "test",
    user: "app_owner",
    password: "app",
    max: 5,
  });
  appPool.on("error", () => {});

  // Apply the real migration file — the artifact under test.
  const mig = readFileSync(join(__dirname, "..", "..", "migrations", "0021_rls_phase1.sql"), "utf-8");
  await appPool.query(mig);

  await appPool.query("INSERT INTO memories (user_id, content) VALUES (1, $$a1$$), (1, $$a2$$), (2, $$b1$$)");
  await appPool.query("INSERT INTO rooms (user_id, name) VALUES (1, $$room-a$$), (2, $$room-b$$)");
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  // Drain grace so socket teardown completes before postgres dies (57P01 guard).
  await new Promise((r) => setTimeout(r, 250));
  await container?.stop();
});

async function wrapped<T>(pool: Pool, userId: number, fn: (c: any) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($$app.user_id$$, $1::text, true)", [String(userId)]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

describe("RLS Phase 1 isolation (migrations/0021 on live Postgres)", () => {
  test("FORCE is active on both tables", async () => {
    const r = await adminPool.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ($$memories$$, $$rooms$$) ORDER BY relname",
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test("wrapped session for user 1 sees only user 1 rows — no WHERE clause", async () => {
    const rows = await wrapped(appPool, 1, async (c) => (await c.query("SELECT user_id FROM memories ORDER BY id")).rows);
    expect(rows.map((r: any) => r.user_id)).toEqual([1, 1]);
    const rooms = await wrapped(appPool, 1, async (c) => (await c.query("SELECT name FROM rooms")).rows);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].name).toBe("room-a");
  });

  test("wrapped session for user 2 cannot see user 1 rows", async () => {
    const rows = await wrapped(appPool, 2, async (c) => (await c.query("SELECT content FROM memories")).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("b1");
  });

  test("wrapped session for a user with no rows sees zero rows", async () => {
    const rows = await wrapped(appPool, 999, async (c) => (await c.query("SELECT * FROM memories")).rows);
    expect(rows).toHaveLength(0);
  });

  test("legacy session (GUC unset) still sees all rows — PR1 backdoor (fix #5)", async () => {
    const m = await appPool.query("SELECT count(*)::int AS c FROM memories");
    expect(m.rows[0].c).toBe(3);
    const r = await appPool.query("SELECT count(*)::int AS c FROM rooms");
    expect(r.rows[0].c).toBe(2);
  });

  test("down migration disables RLS cleanly", async () => {
    const down = readFileSync(join(__dirname, "..", "..", "migrations", "0021_rls_phase1_down.sql"), "utf-8");
    await appPool.query(down);
    const r = await adminPool.query("SELECT relrowsecurity FROM pg_class WHERE relname = $$memories$$");
    expect(r.rows[0].relrowsecurity).toBe(false);
    // Re-apply for any later assertions / symmetry with prod state.
    const mig = readFileSync(join(__dirname, "..", "..", "migrations", "0021_rls_phase1.sql"), "utf-8");
    await appPool.query(mig);
  });
});

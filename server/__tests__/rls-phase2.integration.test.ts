/**
 * [LUCA-087] RLS Phase 2 — real-Postgres isolation acceptance for
 * room_messages (JOIN policy), agent_turns, and agents (llm_api_key).
 * Same harness shape as rls-isolation.integration.test.ts: non-superuser
 * owner role mirrors Neon (the app role is never superuser there).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

let container: StartedPostgreSqlContainer;
let adminPool: Pool;
let appPool: Pool;

function mig(name: string): string {
  return readFileSync(join(__dirname, "..", "..", "migrations", name), "utf-8");
}

async function wrapped<T>(userId: number, fn: (c: any) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
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

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test").withUsername("test").withPassword("test").start();
  adminPool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  adminPool.on("error", () => {});

  await adminPool.query("CREATE ROLE app_owner LOGIN PASSWORD $$app$$ NOSUPERUSER");
  await adminPool.query("CREATE TABLE rooms (id serial PRIMARY KEY, user_id int NOT NULL, name text)");
  await adminPool.query("CREATE TABLE room_messages (id serial PRIMARY KEY, room_id int NOT NULL, body text)");
  await adminPool.query("CREATE TABLE agent_turns (id serial PRIMARY KEY, user_id int NOT NULL, status text)");
  await adminPool.query("CREATE TABLE agents (id serial PRIMARY KEY, user_id int NOT NULL, llm_api_key text)");
  await adminPool.query("CREATE TABLE memories (id serial PRIMARY KEY, user_id int NOT NULL, content text)");
  for (const t of ["rooms", "room_messages", "agent_turns", "agents", "memories"]) {
    await adminPool.query(`ALTER TABLE ${t} OWNER TO app_owner`);
  }

  appPool = new Pool({
    host: container.getHost(), port: container.getPort(),
    database: "test", user: "app_owner", password: "app", max: 5,
  });
  appPool.on("error", () => {});

  await appPool.query(mig("0021_rls_phase1.sql"));
  await appPool.query(mig("0022_rls_phase2.sql"));

  await appPool.query("INSERT INTO rooms (id, user_id, name) VALUES (1, 1, $$room-a$$), (2, 2, $$room-b$$)");
  await appPool.query("SELECT setval($$rooms_id_seq$$, 2)");
  await appPool.query("INSERT INTO room_messages (room_id, body) VALUES (1, $$msg-a1$$), (1, $$msg-a2$$), (2, $$msg-b1$$)");
  await appPool.query("INSERT INTO agent_turns (user_id, status) VALUES (1, $$pending$$), (2, $$pending$$)");
  await appPool.query("INSERT INTO agents (user_id, llm_api_key) VALUES (1, $$sk-user1-secret$$), (2, $$sk-user2-secret$$)");
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await new Promise((r) => setTimeout(r, 250));
  await container?.stop();
});

describe("RLS Phase 2 isolation (migrations/0022 on live Postgres)", () => {
  test("FORCE active on all three Phase 2 tables", async () => {
    const r = await adminPool.query(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ($$room_messages$$, $$agent_turns$$, $$agents$$) ORDER BY relname",
    );
    expect(r.rows).toHaveLength(3);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test("room_messages JOIN policy: user 1 sees only messages of own rooms — no WHERE", async () => {
    const rows = await wrapped(1, async (c) => (await c.query("SELECT body FROM room_messages ORDER BY id")).rows);
    expect(rows.map((r: any) => r.body)).toEqual(["msg-a1", "msg-a2"]);
  });

  test("room_messages: user 2 cannot see user 1 room traffic", async () => {
    const rows = await wrapped(2, async (c) => (await c.query("SELECT body FROM room_messages")).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("msg-b1");
  });

  test("room_messages WITH CHECK: user 1 cannot INSERT into user 2 room", async () => {
    await expect(
      wrapped(1, async (c) => c.query("INSERT INTO room_messages (room_id, body) VALUES (2, $$intrusion$$)")),
    ).rejects.toThrow(/row-level security/);
  });

  test("agent_turns: pending turns isolated by user", async () => {
    const rows = await wrapped(1, async (c) => (await c.query("SELECT user_id FROM agent_turns")).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(1);
  });

  test("agents: llm_api_key does not leak across users", async () => {
    const rows = await wrapped(1, async (c) => (await c.query("SELECT llm_api_key FROM agents")).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0].llm_api_key).toBe("sk-user1-secret");
    const other = await wrapped(2, async (c) => (await c.query("SELECT llm_api_key FROM agents WHERE user_id = 1")).rows);
    expect(other).toHaveLength(0);
  });

  test("legacy session (GUC unset) still sees everything — backdoor until PR3", async () => {
    const m = await appPool.query("SELECT count(*)::int AS c FROM room_messages");
    expect(m.rows[0].c).toBe(3);
    const a = await appPool.query("SELECT count(*)::int AS c FROM agents");
    expect(a.rows[0].c).toBe(2);
  });

  test("down migration disables Phase 2 RLS cleanly", async () => {
    await appPool.query(mig("0022_rls_phase2_down.sql"));
    const r = await adminPool.query("SELECT relrowsecurity FROM pg_class WHERE relname = $$agents$$");
    expect(r.rows[0].relrowsecurity).toBe(false);
    await appPool.query(mig("0022_rls_phase2.sql"));
  });
});

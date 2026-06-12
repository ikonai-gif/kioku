/**
 * [LUCA-091] RLS PR3 -- strict-policy acceptance on live Postgres.
 *
 * Applies 0021+0022 (+ a minimal luca_skills with 0024-equivalent RLS) and
 * then 0026. Asserts the post-backdoor world: empty GUC sees nothing
 * (except luca_skills globals), the service marker sees everything, users
 * see exactly their own rows, and the down migration restores the backdoor.
 * NOTE: 0026 is intentionally NOT in bootstrap -- prod stays on the
 * backdoor until the full 105-touchpoint inventory is wrapped (BOSS GO).
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

async function withGuc<T>(guc: string, value: string, fn: (c: any) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", [guc, value]);
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
  await adminPool.query("CREATE TABLE luca_skills (id serial PRIMARY KEY, user_id int, name varchar(64), prompt_template text)");
  for (const t of ["rooms", "room_messages", "agent_turns", "agents", "memories", "luca_skills"]) {
    await adminPool.query(`ALTER TABLE ${t} OWNER TO app_owner`);
  }

  appPool = new Pool({
    host: container.getHost(), port: container.getPort(),
    database: "test", user: "app_owner", password: "app", max: 5,
  });
  appPool.on("error", () => {});

  await appPool.query(mig("0021_rls_phase1.sql"));
  await appPool.query(mig("0022_rls_phase2.sql"));
  // 0024-equivalent RLS for the minimal luca_skills shape
  await appPool.query("ALTER TABLE luca_skills ENABLE ROW LEVEL SECURITY");
  await appPool.query("ALTER TABLE luca_skills FORCE ROW LEVEL SECURITY");
  await appPool.query("CREATE POLICY skills_user_isolation ON luca_skills USING (user_id IS NULL OR COALESCE(current_setting($$app.user_id$$, true), $$$$) = $$$$ OR user_id = NULLIF(current_setting($$app.user_id$$, true), $$$$)::int)");

  await appPool.query("INSERT INTO rooms (id, user_id, name) VALUES (1, 1, $$a$$), (2, 2, $$b$$)");
  await appPool.query("INSERT INTO room_messages (room_id, body) VALUES (1, $$m1$$), (2, $$m2$$)");
  await appPool.query("INSERT INTO agent_turns (user_id, status) VALUES (1, $$pending$$), (2, $$pending$$)");
  await appPool.query("INSERT INTO agents (user_id, llm_api_key) VALUES (1, $$k1$$), (2, $$k2$$)");
  await appPool.query("INSERT INTO memories (user_id, content) VALUES (1, $$m-u1$$), (2, $$m-u2$$)");
  await appPool.query("INSERT INTO luca_skills (user_id, name, prompt_template) VALUES (NULL, $$global_skill$$, $$p$$), (1, $$u1_skill$$, $$p$$)");

  await appPool.query(mig("0026_rls_strict.sql"));
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await new Promise((r) => setTimeout(r, 250));
  await container?.stop();
});

describe("RLS PR3 strict policies (migrations/0026 on live Postgres)", () => {
  test("empty GUC sees NOTHING on user tables -- backdoor is gone", async () => {
    for (const t of ["memories", "rooms", "room_messages", "agent_turns", "agents"]) {
      const r = await appPool.query(`SELECT count(*)::int AS c FROM ${t}`);
      expect(r.rows[0].c, t).toBe(0);
    }
  });

  test("empty GUC on luca_skills sees only globals (public by design)", async () => {
    const r = await appPool.query("SELECT name FROM luca_skills");
    expect(r.rows.map((x: any) => x.name)).toEqual(["global_skill"]);
  });

  test("service marker sees everything (transaction-local)", async () => {
    const counts = await withGuc("app.kioku_service", "true", async (c) => {
      const m = await c.query("SELECT count(*)::int AS c FROM memories");
      const rm = await c.query("SELECT count(*)::int AS c FROM room_messages");
      const sk = await c.query("SELECT count(*)::int AS c FROM luca_skills");
      return [m.rows[0].c, rm.rows[0].c, sk.rows[0].c];
    });
    expect(counts).toEqual([2, 2, 2]);
    // marker does NOT leak outside the transaction
    const after = await appPool.query("SELECT count(*)::int AS c FROM memories");
    expect(after.rows[0].c).toBe(0);
  });

  test("user scoping still exact: user 1 sees only own rows + globals", async () => {
    const out = await withGuc("app.user_id", "1", async (c) => {
      const m = await c.query("SELECT content FROM memories");
      const msgs = await c.query("SELECT body FROM room_messages");
      const sk = await c.query("SELECT name FROM luca_skills ORDER BY name");
      const keys = await c.query("SELECT llm_api_key FROM agents");
      return { m: m.rows, msgs: msgs.rows, sk: sk.rows, keys: keys.rows };
    });
    expect(out.m).toEqual([{ content: "m-u1" }]);
    expect(out.msgs).toEqual([{ body: "m1" }]);
    expect(out.sk.map((x: any) => x.name)).toEqual(["global_skill", "u1_skill"]);
    expect(out.keys).toEqual([{ llm_api_key: "k1" }]);
  });

  test("down migration restores the backdoor cleanly", async () => {
    await appPool.query(mig("0026_rls_strict_down.sql"));
    const r = await appPool.query("SELECT count(*)::int AS c FROM memories");
    expect(r.rows[0].c).toBe(2);
    await appPool.query(mig("0026_rls_strict.sql"));
    const r2 = await appPool.query("SELECT count(*)::int AS c FROM memories");
    expect(r2.rows[0].c).toBe(0);
  });
});

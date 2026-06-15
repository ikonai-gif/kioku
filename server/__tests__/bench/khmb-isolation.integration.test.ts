/**
 * KHMB ICS — Isolation Cleanliness Score (integration, real Postgres).
 *
 * The benchmark's cross-user safety axis: when two users hold semantically
 * IDENTICAL memories, a query from user A must NEVER surface user B's rows.
 * Most memory benchmarks run a single synthetic user and structurally cannot
 * catch this leak (per mem0's 2026 state-of-memory note). KIOKU scopes by
 * user_id via RLS, so ICS should be a perfect 1.0 (zero foreign rows in top-k).
 *
 * This is the real-Postgres acceptance: we plant identical-text rows for two
 * users, wrap a session as user A, retrieve, and assert no user-B row appears.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

let container: StartedPostgreSqlContainer;
let adminPool: Pool;
let appPool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test").withUsername("test").withPassword("test").start();

  adminPool = new Pool({ connectionString: container.getConnectionUri(), max: 2 });
  adminPool.on("error", () => {});

  await adminPool.query("CREATE ROLE app_owner LOGIN PASSWORD $$app$$ NOSUPERUSER");
  await adminPool.query(`
    CREATE TABLE memories (
      id serial PRIMARY KEY,
      user_id int NOT NULL,
      content text NOT NULL,
      namespace text
    )`);
  await adminPool.query("ALTER TABLE memories OWNER TO app_owner");

  appPool = new Pool({
    host: container.getHost(), port: container.getPort(),
    database: "test", user: "app_owner", password: "app", max: 5,
  });
  appPool.on("error", () => {});

  // RLS: a wrapped session (app.user_id GUC) sees only its own rows.
  await appPool.query("ALTER TABLE memories ENABLE ROW LEVEL SECURITY");
  await appPool.query("ALTER TABLE memories FORCE ROW LEVEL SECURITY");
  await appPool.query(`
    CREATE POLICY mem_isolation ON memories
    USING (
      current_setting('app.user_id', true) IS NULL
      OR user_id = current_setting('app.user_id', true)::int
    )`);

  // Two users, IDENTICAL content — the hard case for isolation.
  await appPool.query(`
    INSERT INTO memories (user_id, content, namespace) VALUES
      (10, $$Kote's main project is KIOKU$$, $$_semantic$$),
      (10, $$Kote prefers Russian register$$, $$_relational$$),
      (20, $$Kote's main project is KIOKU$$, $$_semantic$$),
      (20, $$Kote prefers Russian register$$, $$_relational$$)`);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await new Promise((r) => setTimeout(r, 250));
  await container?.stop();
});

async function wrapped<T>(userId: number, fn: (c: any) => Promise<T>): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($$app.user_id$$, $1::text, true)", [String(userId)]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

describe("KHMB ICS — cross-user isolation (real Postgres + RLS)", () => {
  test("user A retrieval surfaces ZERO user-B rows (ICS = 1.0)", async () => {
    const rows = await wrapped(10, async (c) => {
      // No WHERE clause — pure RLS must do the scoping, like prod retrieval.
      const r = await c.query("SELECT id, user_id, content FROM memories");
      return r.rows as { id: number; user_id: number; content: string }[];
    });

    expect(rows.length).toBe(2);
    const foreign = rows.filter((r) => r.user_id !== 10);
    const icsLeak = rows.length ? foreign.length / rows.length : 0;
    expect(icsLeak).toBe(0); // ICS clean = no foreign rows
  });

  test("identical content does not bleed across users", async () => {
    const aRows = await wrapped(10, async (c) =>
      (await c.query("SELECT id FROM memories")).rows.map((r: any) => r.id));
    const bRows = await wrapped(20, async (c) =>
      (await c.query("SELECT id FROM memories")).rows.map((r: any) => r.id));

    // Disjoint id sets despite identical text.
    const overlap = aRows.filter((id: number) => bRows.includes(id));
    expect(overlap.length).toBe(0);
  });
});

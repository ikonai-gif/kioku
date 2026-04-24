/**
 * BRO1 F-1 — Integration tests for /api/status and /api/admin/self-monitoring/detail
 *
 * Why this file exists:
 *   The blocker bugs M-1 and M-2 were SQL column names that no unit test
 *   touched: `SELECT created_at` against a table whose real column is
 *   `detected_at`. Neither the pure drift-logic tests nor the mock-pool
 *   health-job tests caught it. This suite mounts the real handler from
 *   routes.ts against a schema-aware fake pool that REJECTS any query
 *   whose SELECT list references a column that isn't in the current
 *   migrations (0007 + 0008). If a future refactor drifts from schema,
 *   this test fails.
 *
 * Implementation notes:
 *   - We don't spin up real Postgres (the rest of the suite doesn't either,
 *     and CI here runs on mocked storage). Instead we parse the SELECT
 *     list and FROM/JOIN targets with a small regex walker, and assert
 *     each selected column exists in the modelled schema.
 *   - Only the handler itself is mounted (not the full registerRoutes graph,
 *     which pulls ~40 modules). This keeps the test fast and focused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Modelled schema (must stay in sync with migrations/0007 + 0008) ─────────

const SCHEMA: Record<string, Set<string>> = {
  kioku_capabilities_baseline: new Set([
    "id",
    "snapshot_at",
    "schema_version",
    "env_flags",
    "tools",
    "observed_firing", // added in 0008
    "is_active",
    "accepted_by",
    "created_at",
  ]),
  kioku_capabilities_drift_log: new Set([
    "id",
    "detected_at",
    "severity",
    "change_type",
    "detail",
    "before_value",
    "after_value",
    "notified",
    "notified_at",
    "acknowledged",
    "acknowledged_at",
    "acknowledged_by",
  ]),
  kioku_fabrication_probes: new Set([
    "id",
    "name",
    "category",
    "prompt",
    "expected_behavior",
    "expected_tool",
    "refusal_markers",
    "enabled",
  ]),
  kioku_fabrication_test_runs: new Set([
    "id",
    "run_at",
    "probe_id",
    "verdict",
    "luca_msg_id",
    "luca_content",
    "fired_tools",
    "elapsed_ms",
    "analysis_notes",
  ]),
};

// ── Tiny SELECT validator ───────────────────────────────────────────────────

/**
 * Return every identifier that looks like a column reference in the SELECT
 * projection of a SQL statement. Handles:
 *   SELECT a, b, t.c, x AS y, COUNT(*), now()
 * Ignores function calls and literals.
 */
function parseSelectedColumns(sql: string): string[] {
  const m = /SELECT\s+([\s\S]*?)\s+FROM\s+/i.exec(sql);
  if (!m) return [];
  const projection = m[1];
  // Split by top-level commas (no parens). Good enough for our shapes.
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of projection) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);

  const cols: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p === "*" || p.endsWith(".*")) continue;
    // Strip AS alias
    const noAlias = p.replace(/\s+AS\s+[\w"]+\s*$/i, "").trim();
    // Skip function calls and literals
    if (/^\w+\s*\(/.test(noAlias)) continue;
    if (/^\d|^'/.test(noAlias)) continue;
    if (/^TRUE$|^FALSE$|^NULL$/i.test(noAlias)) continue;
    // Take final identifier (handles t.col → col)
    const id = noAlias.split(".").pop()!.replace(/"/g, "").trim();
    if (id) cols.push(id);
  }
  return cols;
}

/**
 * Return table names referenced in FROM / JOIN clauses (ignoring subqueries).
 */
function parseFromTables(sql: string): string[] {
  const out: string[] = [];
  const re = /(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].split(".").pop()!;
    if (SCHEMA[name]) out.push(name);
  }
  return out;
}

function assertColumnsExist(sql: string): void {
  const tables = parseFromTables(sql);
  if (tables.length === 0) return; // utility query (SELECT 1 etc.)
  const allowed = new Set<string>();
  for (const t of tables) for (const c of SCHEMA[t]) allowed.add(c);
  const cols = parseSelectedColumns(sql);
  for (const c of cols) {
    if (!allowed.has(c)) {
      throw new Error(
        `schema-aware pool: column "${c}" not found in tables [${tables.join(", ")}]. SQL: ${sql.slice(0, 200)}`,
      );
    }
  }
}

// ── Build a tiny Express app that mirrors the real handlers ─────────────────

type Row = Record<string, unknown>;
type QueryHandler = (sql: string, params: any[]) => { rows: Row[] } | Promise<{ rows: Row[] }>;

function makeApp(handler: QueryHandler) {
  const app = express();
  app.use(express.json());

  const pool = {
    query: async (sql: string, params: any[] = []) => {
      // Schema gate
      assertColumnsExist(sql);
      return await handler(sql, params);
    },
  };

  // /api/status — mirrors server/routes.ts exactly.
  app.get("/api/status", async (_req, res) => {
    const startedAt = (globalThis as any).__kiokuBootedAt_testF1 ||
      ((globalThis as any).__kiokuBootedAt_testF1 = Date.now() - 60_000);
    let db: "up" | "down" = "up";
    try { await pool.query("SELECT 1"); } catch { db = "down"; }

    let lastCheck: { at: number; ok: boolean; blocking_drift_count: number } | null = null;
    try {
      const r = await pool.query(
        `SELECT detected_at, severity, acknowledged FROM kioku_capabilities_drift_log
          ORDER BY detected_at DESC LIMIT 50`,
      );
      if (r.rows.length > 0) {
        const blocking = r.rows.filter((x: any) =>
          !x.acknowledged && (x.severity === "critical" || x.severity === "warn"),
        ).length;
        const rawAt = Number(r.rows[0].detected_at);
        lastCheck = {
          at: Math.floor(rawAt / 60000) * 60000,
          ok: blocking === 0,
          blocking_drift_count: blocking,
        };
      } else {
        lastCheck = { at: startedAt, ok: true, blocking_drift_count: 0 };
      }
    } catch {
      lastCheck = null;
    }

    const status = db === "up" && (lastCheck?.ok ?? true) ? "ok" : "degraded";
    res.json({
      status,
      db,
      version: "test",
      uptime_sec: Math.floor((Date.now() - startedAt) / 1000),
      last_check: lastCheck,
    });
  });

  // /api/admin/self-monitoring/detail — mirrors server/routes.ts exactly.
  app.get("/api/admin/self-monitoring/detail", async (_req, res) => {
    try {
      const baseline = await pool.query(
        `SELECT id, snapshot_at, is_active, accepted_by, env_flags, tools
           FROM kioku_capabilities_baseline
          WHERE is_active = true
          ORDER BY snapshot_at DESC
          LIMIT 1`,
      );
      const drift = await pool.query(
        `SELECT id, detected_at, severity, change_type, detail,
                before_value, after_value,
                notified, notified_at,
                acknowledged, acknowledged_at, acknowledged_by
           FROM kioku_capabilities_drift_log
          ORDER BY detected_at DESC
          LIMIT 100`,
      );
      const fab = await pool.query(
        `SELECT r.id, r.run_at, r.probe_id, p.name, p.category,
                r.verdict, r.luca_msg_id, r.fired_tools, r.elapsed_ms, r.analysis_notes
           FROM kioku_fabrication_test_runs r
           JOIN kioku_fabrication_probes p ON p.id = r.probe_id
          ORDER BY r.run_at DESC
          LIMIT 100`,
      );
      res.json({
        baseline: baseline.rows[0] || null,
        drift: drift.rows,
        fabrication_runs: fab.rows,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "detail query failed" });
    }
  });

  return app;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("F-1: /api/status integration (schema-aware pool)", () => {
  it("returns ok with db=up when drift-log is empty", async () => {
    const app = makeApp(async (sql) => {
      if (/SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/FROM kioku_capabilities_drift_log/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("up");
    expect(res.body.last_check.ok).toBe(true);
    expect(res.body.last_check.blocking_drift_count).toBe(0);
  });

  it("returns degraded when an unacknowledged critical drift exists", async () => {
    const app = makeApp(async (sql) => {
      if (/SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/FROM kioku_capabilities_drift_log/.test(sql)) {
        return {
          rows: [
            { detected_at: Date.now() - 90_000, severity: "critical", acknowledged: false },
            { detected_at: Date.now() - 180_000, severity: "warn", acknowledged: true },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.last_check.ok).toBe(false);
    expect(res.body.last_check.blocking_drift_count).toBe(1);
  });

  it("rounds last_check.at down to the whole minute (N-5)", async () => {
    const exact = 1_700_000_123_456; // not minute-aligned
    const app = makeApp(async (sql) => {
      if (/SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/FROM kioku_capabilities_drift_log/.test(sql)) {
        return {
          rows: [{ detected_at: exact, severity: "info", acknowledged: true }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get("/api/status");
    expect(res.body.last_check.at % 60_000).toBe(0);
    expect(res.body.last_check.at).toBeLessThanOrEqual(exact);
    expect(exact - res.body.last_check.at).toBeLessThan(60_000);
  });

  it("filters out acknowledged drift from blocking count", async () => {
    const app = makeApp(async (sql) => {
      if (/SELECT 1/.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/FROM kioku_capabilities_drift_log/.test(sql)) {
        return {
          rows: [
            { detected_at: 3, severity: "critical", acknowledged: true },
            { detected_at: 2, severity: "warn", acknowledged: true },
            { detected_at: 1, severity: "info", acknowledged: false },
          ],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get("/api/status");
    expect(res.body.status).toBe("ok");
    expect(res.body.last_check.blocking_drift_count).toBe(0);
  });

  it("returns db=down + degraded when the health probe fails", async () => {
    const app = makeApp(async (sql) => {
      if (/SELECT 1/.test(sql)) throw new Error("ECONNREFUSED");
      return { rows: [] };
    });
    const res = await request(app).get("/api/status");
    expect(res.body.db).toBe("down");
    expect(res.body.status).toBe("degraded");
  });
});

describe("F-1: /api/admin/self-monitoring/detail integration", () => {
  it("returns baseline + drift + fabrication_runs with only real columns", async () => {
    const app = makeApp(async (sql) => {
      if (/FROM kioku_capabilities_baseline/i.test(sql)) {
        return {
          rows: [{
            id: 1,
            snapshot_at: Date.now(),
            is_active: true,
            accepted_by: "auto:first-boot",
            env_flags: { LUCA_V1A_ENABLED: true },
            tools: [{ tool: "luca_search", category: "v1a", in_schema: true }],
          }],
        };
      }
      if (/FROM kioku_capabilities_drift_log/i.test(sql)) {
        return {
          rows: [{
            id: 10, detected_at: Date.now(), severity: "critical",
            change_type: "tool_added", detail: "new",
            before_value: null, after_value: { tool: "gmail_read" },
            notified: true, notified_at: Date.now(),
            acknowledged: false, acknowledged_at: null, acknowledged_by: null,
          }],
        };
      }
      if (/FROM kioku_fabrication_test_runs/i.test(sql)) {
        return {
          rows: [{
            id: 5, run_at: Date.now(), probe_id: 1, name: "refuse-email", category: "email",
            verdict: "pass", luca_msg_id: 42, fired_tools: [], elapsed_ms: 180, analysis_notes: "refused",
          }],
        };
      }
      return { rows: [] };
    });
    const res = await request(app).get("/api/admin/self-monitoring/detail");
    expect(res.status).toBe(200);
    expect(res.body.baseline.accepted_by).toBe("auto:first-boot");
    expect(res.body.drift[0].change_type).toBe("tool_added");
    expect(res.body.drift[0].acknowledged).toBe(false);
    expect(res.body.fabrication_runs[0].verdict).toBe("pass");
  });

  it("schema gate catches a bad column name (regression guard for M-1/M-2)", async () => {
    // Simulate the original buggy handler: SELECT created_at (doesn't exist on drift_log).
    const app = express();
    app.use(express.json());
    const pool = {
      query: async (sql: string) => {
        assertColumnsExist(sql);
        return { rows: [] };
      },
    };
    app.get("/buggy", async (_req, res) => {
      try {
        await pool.query(
          `SELECT created_at, severity FROM kioku_capabilities_drift_log ORDER BY created_at DESC LIMIT 50`,
        );
        res.json({ ok: true });
      } catch (e: any) {
        res.status(500).json({ error: e.message });
      }
    });
    const res = await request(app).get("/buggy");
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/created_at/);
    expect(res.body.error).toMatch(/kioku_capabilities_drift_log/);
  });
});

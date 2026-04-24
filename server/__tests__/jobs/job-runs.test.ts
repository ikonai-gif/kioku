/**
 * Tests for lib/jobs/job-runs.ts — claim + advisory-lock + run lifecycle.
 *
 * Uses a fake pool backed by a simple in-memory state that models:
 *   - the kioku_job_runs table as a Map keyed on (job_id, utc_day)
 *   - pg_try_advisory_lock() as a Set of held keys
 *
 * This keeps tests fast and deterministic without pg. A real-DB integration
 * test path would live separately if/when we add testcontainers.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { runWithClaim, utcDay, jobLockKey } from "../../lib/jobs/job-runs";

type Row = {
  id: number;
  job_id: string;
  utc_day: string;
  status: "running" | "ok" | "error" | "skipped";
  finished_at: string | null;
  duration_ms: number | null;
  error: string | null;
  detail: Record<string, unknown>;
};

function makeFakePool() {
  let nextId = 1;
  const rows = new Map<string, Row>(); // key: `${job_id}|${utc_day}`
  const locks = new Set<number>();
  const clientCalls: Array<{ sql: string; args: any[] }> = [];

  const query = async (sql: string, args: any[] = []) => {
    const s = sql.trim();

    // INSERT claim
    if (/^INSERT INTO kioku_job_runs/i.test(s)) {
      const [job_id, utc_day] = args;
      const key = `${job_id}|${utc_day}`;
      if (rows.has(key)) return { rows: [], rowCount: 0 };
      const id = nextId++;
      const row: Row = {
        id,
        job_id,
        utc_day,
        status: "running",
        finished_at: null,
        duration_ms: null,
        error: null,
        detail: {},
      };
      rows.set(key, row);
      return { rows: [{ id }], rowCount: 1 };
    }

    // UPDATE on skip
    if (/UPDATE kioku_job_runs\s+SET status = 'skipped'/i.test(s)) {
      const [id] = args;
      for (const r of rows.values()) {
        if (r.id === id) {
          r.status = "skipped";
          r.detail.skip_reason = "lock_held";
        }
      }
      return { rows: [], rowCount: 1 };
    }

    // UPDATE final
    if (/UPDATE kioku_job_runs\s+SET status = \$2/i.test(s)) {
      const [id, status, duration_ms, error, detailJson] = args;
      for (const r of rows.values()) {
        if (r.id === id) {
          r.status = status;
          r.duration_ms = duration_ms;
          r.error = error;
          r.finished_at = new Date().toISOString();
          Object.assign(r.detail, JSON.parse(detailJson));
        }
      }
      return { rows: [], rowCount: 1 };
    }

    throw new Error("unexpected SQL: " + s);
  };

  const connect = async () => ({
    query: async (sql: string, args: any[] = []) => {
      clientCalls.push({ sql, args });
      const m = /pg_try_advisory_lock\(\$1\)/.exec(sql);
      if (m) {
        const key = args[0];
        if (locks.has(key)) return { rows: [{ got: false }] };
        locks.add(key);
        return { rows: [{ got: true }] };
      }
      if (/pg_advisory_unlock\(\$1\)/.test(sql)) {
        locks.delete(args[0]);
        return { rows: [] };
      }
      throw new Error("unexpected client SQL: " + sql);
    },
    release: () => {},
  });

  return {
    pool: { query, connect } as any,
    rows,
    locks,
    clientCalls,
  };
}

describe("jobs/job-runs · utcDay", () => {
  it("formats YYYY-MM-DD in UTC", () => {
    expect(utcDay(new Date(Date.UTC(2026, 3, 24, 13, 0, 0)))).toBe("2026-04-24");
    expect(utcDay(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe("2026-01-01");
  });
});

describe("jobs/job-runs · jobLockKey", () => {
  it("is deterministic", () => {
    expect(jobLockKey("daily-user-backup")).toBe(jobLockKey("daily-user-backup"));
  });
  it("fits signed int32 positive range", () => {
    const k = jobLockKey("missed-by-both-annual-review");
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(0x7fffffff);
  });
  it("differs for different inputs", () => {
    expect(jobLockKey("a")).not.toBe(jobLockKey("b"));
  });
});

describe("jobs/job-runs · runWithClaim", () => {
  let fp: ReturnType<typeof makeFakePool>;
  beforeEach(() => {
    fp = makeFakePool();
  });

  it("runs the function and persists status=ok on success", async () => {
    const result = await runWithClaim(
      "test-job",
      async () => ({ widgets: 42 }),
      { poolOverride: fp.pool, now: new Date(Date.UTC(2026, 3, 24, 13, 0)) },
    );
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.status).toBe("ok");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
    const row = [...fp.rows.values()][0];
    expect(row.status).toBe("ok");
    expect(row.detail.widgets).toBe(42);
    expect(row.error).toBeNull();
  });

  it("persists status=error and returns when job throws", async () => {
    const result = await runWithClaim(
      "boom-job",
      async () => {
        throw new Error("boom");
      },
      { poolOverride: fp.pool, now: new Date(Date.UTC(2026, 3, 24, 13, 0)) },
    );
    expect(result.ran).toBe(true);
    if (result.ran) expect(result.status).toBe("error");
    const row = [...fp.rows.values()][0];
    expect(row.status).toBe("error");
    expect(row.error).toBe("boom");
  });

  it("returns skipped=already_claimed on 2nd call same day", async () => {
    const opts = {
      poolOverride: fp.pool,
      now: new Date(Date.UTC(2026, 3, 24, 13, 0)),
    };
    const r1 = await runWithClaim("once-job", async () => {}, opts);
    expect(r1.ran).toBe(true);
    const r2 = await runWithClaim("once-job", async () => {}, opts);
    expect(r2.ran).toBe(false);
    if (!r2.ran) expect(r2.reason).toBe("already_claimed");
  });

  it("allows claim on next UTC day", async () => {
    const day1 = { poolOverride: fp.pool, now: new Date(Date.UTC(2026, 3, 24, 13, 0)) };
    const day2 = { poolOverride: fp.pool, now: new Date(Date.UTC(2026, 3, 25, 13, 0)) };
    await runWithClaim("daily-job", async () => {}, day1);
    const r2 = await runWithClaim("daily-job", async () => {}, day2);
    expect(r2.ran).toBe(true);
  });

  it("acquires + releases advisory lock", async () => {
    await runWithClaim("lock-job", async () => {}, {
      poolOverride: fp.pool,
      now: new Date(Date.UTC(2026, 3, 24, 13, 0)),
    });
    // Lock should be released after the run.
    expect(fp.locks.size).toBe(0);
    // Both acquire and release queries should have been issued.
    const sqls = fp.clientCalls.map((c) => c.sql.replace(/\s+/g, " ")).join("|");
    expect(sqls).toMatch(/pg_try_advisory_lock/);
    expect(sqls).toMatch(/pg_advisory_unlock/);
  });

  it("skips with lock_held when lock acquisition fails", async () => {
    // Pre-seed the lock so runWithClaim sees it busy.
    fp.locks.add(jobLockKey("contested-job"));
    const result = await runWithClaim(
      "contested-job",
      async () => {
        throw new Error("should not run");
      },
      { poolOverride: fp.pool, now: new Date(Date.UTC(2026, 3, 24, 13, 0)) },
    );
    expect(result.ran).toBe(false);
    if (!result.ran) expect(result.reason).toBe("lock_held");
    const row = [...fp.rows.values()][0];
    expect(row.status).toBe("skipped");
    expect(row.detail.skip_reason).toBe("lock_held");
  });
});

/**
 * Tests for runMigration() migration guard (server/storage.ts).
 *
 * Uses mocked pool.query so no live DATABASE_URL is required.
 * The pool is intercepted via vi.mock('pg').
 *
 * Vitest hoists vi.mock() factories above imports. We use vi.hoisted() to
 * declare shared mock state so it is available inside factory closures.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoist shared mock so it is available inside vi.mock factory ───────────────
const { poolMock } = vi.hoisted(() => {
  const poolMock = {
    query: vi.fn(),
    on: vi.fn(),
    end: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
  };
  return { poolMock };
});

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('pg', () => {
  function MockPool(this: any) {
    this.query = (...args: any[]) => poolMock.query(...args);
    this.on = (...args: any[]) => poolMock.on(...args);
    this.end = (...args: any[]) => poolMock.end(...args);
    this.connect = (...args: any[]) => poolMock.connect(...args);
  }
  return { Pool: MockPool };
});

vi.mock('../embeddings', () => ({ embedText: vi.fn() }));
vi.mock('../memory-decay', () => ({
  computeDecayedStrength: vi.fn(),
  computeDecayedConfidence: vi.fn(),
}));
vi.mock('../emotion-scorer', () => ({ scoreEmotion: vi.fn() }));
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: vi.fn(() => ({})),
}));

import { runMigration } from '../storage';

// ── Types ─────────────────────────────────────────────────────────────────────
type QueryResult = { rowCount: number; rows: any[] };

// ── Test helpers ─────────────────────────────────────────────────────────────

function claimed(): QueryResult { return { rowCount: 1, rows: [] }; }
function alreadyClaimed(): QueryResult { return { rowCount: 0, rows: [] }; }
function ok(): QueryResult { return { rowCount: 1, rows: [] }; }

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  poolMock.query = vi.fn();
  poolMock.on = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('runMigration — atomic claim via INSERT ON CONFLICT DO NOTHING', () => {
  it('runs sql and updates duration when INSERT succeeds (rowCount=1)', async () => {
    poolMock.query
      .mockResolvedValueOnce(claimed())  // INSERT claim
      .mockResolvedValueOnce(ok())       // migration sql
      .mockResolvedValueOnce(ok());      // UPDATE duration_ms

    await runMigration('v_test_001', 'SELECT 1;');

    expect(poolMock.query).toHaveBeenCalledTimes(3);
  });

  it('skips sql when INSERT returns rowCount=0 (already applied)', async () => {
    poolMock.query.mockResolvedValueOnce(alreadyClaimed());

    await runMigration('v_test_002', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS x TEXT');

    expect(poolMock.query).toHaveBeenCalledTimes(1);
  });

  it('passes the correct version string to the INSERT claim', async () => {
    poolMock.query
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await runMigration('v2026_04_21_001_meeting_room_week3', 'SELECT 1;');

    const insertArgs = (poolMock.query.mock.calls[0] as any[])[1];
    expect(insertArgs).toContain('v2026_04_21_001_meeting_room_week3');
  });

  it('passes the correct version to UPDATE duration_ms', async () => {
    poolMock.query
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await runMigration('v_test_003', 'SELECT 1;');

    const updateSql = (poolMock.query.mock.calls[2] as any[])[0] as string;
    const updateArgs = (poolMock.query.mock.calls[2] as any[])[1] as any[];
    expect(updateSql).toMatch(/UPDATE schema_migrations SET duration_ms/i);
    expect(updateArgs).toContain('v_test_003');
  });

  it('executes the provided sql as the second query', async () => {
    const migrationSql = 'CREATE TABLE IF NOT EXISTS example (id SERIAL PRIMARY KEY)';
    poolMock.query
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await runMigration('v_test_004', migrationSql);

    const sqlCall = (poolMock.query.mock.calls[1] as any[])[0];
    expect(sqlCall).toBe(migrationSql);
  });

  it('returns undefined (void) on success', async () => {
    poolMock.query
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const result = await runMigration('v_test_005', 'SELECT 1;');
    expect(result).toBeUndefined();
  });

  it('returns undefined (void) when already applied (no-op)', async () => {
    poolMock.query.mockResolvedValueOnce(alreadyClaimed());

    const result = await runMigration('v_test_006', 'SELECT 1;');
    expect(result).toBeUndefined();
  });

  it('concurrent race: winner runs 3 queries, loser runs 1 query', async () => {
    // In a real Postgres race, exactly one INSERT ... ON CONFLICT DO NOTHING succeeds
    // (rowCount=1) and the other is a no-op (rowCount=0).
    // We test this sequentially to verify the branching logic:
    // - Instance A (winner): INSERT → sql → UPDATE  (3 queries)
    // - Instance B (loser):  INSERT only            (1 query)
    poolMock.query
      .mockResolvedValueOnce(claimed())  // A: INSERT → rowCount=1, runs sql
      .mockResolvedValueOnce(ok())       // A: migration sql
      .mockResolvedValueOnce(ok());      // A: UPDATE duration
    await runMigration('v_concurrent_a', 'SELECT 1;');
    expect(poolMock.query).toHaveBeenCalledTimes(3);

    // B sees rowCount=0 — already claimed by A
    poolMock.query.mockResolvedValueOnce(alreadyClaimed());
    await runMigration('v_concurrent_b', 'SELECT 1;');
    // B only called 1 more query (INSERT no-op)
    expect(poolMock.query).toHaveBeenCalledTimes(4);
  });

  it('deletes claim row when migration sql throws (allows retry on restart)', async () => {
    poolMock.query
      .mockResolvedValueOnce(claimed())                                       // INSERT claim → rowCount=1
      .mockRejectedValueOnce(new Error('SQL syntax error at line 3'))         // migration sql throws
      .mockResolvedValueOnce(ok());                                           // DELETE unclaim

    await expect(runMigration('v_fail', 'INVALID SQL;')).rejects.toThrow('SQL syntax error');

    // 3 calls total: INSERT claim, failed sql, DELETE cleanup
    expect(poolMock.query).toHaveBeenCalledTimes(3);
    const deleteSql = (poolMock.query.mock.calls[2] as any[])[0] as string;
    const deleteArgs = (poolMock.query.mock.calls[2] as any[])[1] as any[];
    expect(deleteSql).toMatch(/DELETE FROM schema_migrations WHERE version = \$1/i);
    expect(deleteArgs).toContain('v_fail');
  });

  it('does NOT run UPDATE duration_ms when migration sql throws', async () => {
    poolMock.query
      .mockResolvedValueOnce(claimed())
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValueOnce(ok()); // DELETE cleanup

    await expect(runMigration('v_fail_2', 'ALTER TABLE ...;')).rejects.toThrow();

    // No UPDATE call — only INSERT, failed sql, DELETE
    const updateCalls = poolMock.query.mock.calls.filter((call: any[]) =>
      typeof call[0] === 'string' && /UPDATE schema_migrations/i.test(call[0])
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('INSERT uses ON CONFLICT DO NOTHING syntax', async () => {
    poolMock.query.mockResolvedValueOnce(alreadyClaimed());

    await runMigration('v_conflict_check', 'SELECT 1;');

    const insertSql: string = (poolMock.query.mock.calls[0] as any[])[0];
    expect(insertSql).toMatch(/ON CONFLICT DO NOTHING/i);
  });

  it('demo migration version matches expected constant in initDb()', async () => {
    const DEMO_VERSION = 'v2026_04_21_001_meeting_room_week3';
    poolMock.query
      .mockResolvedValueOnce(claimed())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    await runMigration(DEMO_VERSION, 'SELECT 1;');

    const insertArgs = (poolMock.query.mock.calls[0] as any[])[1];
    expect(insertArgs).toContain(DEMO_VERSION);
  });
});

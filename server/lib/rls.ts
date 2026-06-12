/**
 * withRLS — [LUCA-086] RLS Phase 1 helper.
 *
 * Runs `fn` inside a single transaction on one pooled client with
 * app.user_id set via set_config(..., true) (transaction-local, the
 * parameterized-safe equivalent of SET LOCAL — LUCA-086 fix #1).
 * RLS policies on memories/rooms then restrict visibility to that user.
 * Cron and any agent-initiated path MUST use this with the acting userId
 * (e.g. withRLS(10, ...)) — BYPASSRLS is reserved for bootstrap/migrations.
 */
import type { PoolClient } from 'pg';
import { pool } from '../storage';

export async function withRLS<T>(
  userId: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`withRLS: invalid userId ${String(userId)}`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1::text, true)`, [String(userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection-level failure: release below */ }
    throw err;
  } finally {
    client.release();
  }
}

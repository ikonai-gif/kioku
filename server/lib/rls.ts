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

/**
 * withService -- [LUCA-091] RLS PR3 service marker.
 *
 * For internal paths that legitimately operate without a single acting
 * user (agent polling, circuit breaker, Boss supervision ops, GDPR
 * delete). Sets app.kioku_service='true' transaction-locally; under the
 * current (backdoor) policies this is a no-op, and under the strict 0026
 * policies it becomes the only legitimate cross-user path. Never call
 * this from a request handler that has a real userId -- use withRLS.
 */
export async function withService<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.kioku_service', 'true', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* released below */ }
    throw err;
  } finally {
    client.release();
  }
}

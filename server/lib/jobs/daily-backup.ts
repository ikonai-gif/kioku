/**
 * KIOKU™ Internal Jobs — Daily User-State Backup → Google Drive
 *
 * Step 3 (PR #68). Replaces Computer cron eb438bc0 with a self-contained
 * KIOKU job so the product owns its own backup lifecycle.
 *
 * Daily at 13:00 UTC: dumps user state (same shape as /api/admin/dump-user),
 * validates, uploads to Google Drive folder owned by the user.
 *
 * Validation (abort + alert on failure):
 *   - dump size > MIN_DUMP_BYTES (default 100 KB — sanity against truncation)
 *   - dump.user.email matches BACKUP_EXPECTED_EMAIL
 *   - dump.counts.memories > 0  (empty dump = corrupt state or empty DB)
 *
 * ENV:
 *   BACKUP_USER_ID                  userId to dump (required; prod=10)
 *   BACKUP_EXPECTED_EMAIL           sanity-check email on the dumped user
 *   BACKUP_MIN_BYTES                override min-size check (default 102400)
 *   GOOGLE_DRIVE_*                  see drive-uploader.ts
 *   JOBS_WEBHOOK_URL                see jobs-webhook.ts
 *
 * Writes kioku_job_runs detail:
 *   { userId, dump_bytes, drive_file_id, drive_url, counts }
 */

import { pool } from "../../storage";
import logger from "../../logger";
import { uploadBufferToDrive, type DriveLike } from "./drive-uploader";
import { notifyJob } from "./jobs-webhook";

export const DAILY_BACKUP_JOB_ID = "daily-user-backup";

const DEFAULT_MIN_BYTES = 100 * 1024; // 100 KB

type ClientLike = {
  query: (text: string, values?: any[]) => Promise<{ rows: any[] }>;
};

export type BackupDump = {
  meta: {
    dumpedAt: string;
    dumpedAtMs: number;
    userId: number;
    includeEmbeddings: boolean;
    version: number;
  };
  user: { id: number; email: string; name?: string | null; role?: string | null; plan?: string | null };
  counts: Record<string, number>;
  agents: any[];
  memories: any[];
  rooms: any[];
  room_messages: any[];
  flows: any[];
  integrations_meta: any[];
};

/**
 * Pure dump function — same SQL shape as GET /api/admin/dump-user, but
 * callable in-process so the backup job doesn't have to HTTP-hit itself.
 * Exported for tests.
 */
export async function dumpUserForBackup(
  userId: number,
  p: ClientLike = pool,
  opts: { includeEmbeddings?: boolean } = {},
): Promise<BackupDump> {
  const includeEmbeddings = !!opts.includeEmbeddings;

  const userR = await p.query(
    `SELECT id, email, name, role, plan, created_at FROM users WHERE id = $1`,
    [userId],
  );
  if (userR.rows.length === 0) throw new Error(`user ${userId} not found`);
  const user = userR.rows[0];

  const agentsR = await p.query(
    `SELECT * FROM agents WHERE user_id = $1 ORDER BY id ASC`,
    [userId],
  );
  const memCols = includeEmbeddings
    ? "*"
    : "id, user_id, agent_id, agent_name, content, type, importance, namespace, created_at";
  const memoriesR = await p.query(
    `SELECT ${memCols} FROM memories WHERE user_id = $1 ORDER BY id ASC`,
    [userId],
  );
  const roomsR = await p.query(
    `SELECT * FROM rooms WHERE user_id = $1 ORDER BY id ASC`,
    [userId],
  );
  const roomMsgsR = await p.query(
    `SELECT rm.* FROM room_messages rm
       JOIN rooms r ON r.id = rm.room_id
      WHERE r.user_id = $1
      ORDER BY rm.id ASC`,
    [userId],
  );
  const flowsR = await p.query(
    `SELECT * FROM flows WHERE user_id = $1 ORDER BY id ASC`,
    [userId],
  );
  const integrR = await p.query(
    `SELECT id, provider, email, created_at, updated_at, token_expiry
       FROM user_integrations
      WHERE user_id = $1
      ORDER BY id ASC`,
    [userId],
  );

  return {
    meta: {
      dumpedAt: new Date().toISOString(),
      dumpedAtMs: Date.now(),
      userId,
      includeEmbeddings,
      version: 1,
    },
    user,
    counts: {
      agents: agentsR.rows.length,
      memories: memoriesR.rows.length,
      rooms: roomsR.rows.length,
      room_messages: roomMsgsR.rows.length,
      flows: flowsR.rows.length,
      integrations: integrR.rows.length,
    },
    agents: agentsR.rows,
    memories: memoriesR.rows,
    rooms: roomsR.rows,
    room_messages: roomMsgsR.rows,
    flows: flowsR.rows,
    integrations_meta: integrR.rows,
  };
}

export type BackupValidationOk = { ok: true; bytes: number };
export type BackupValidationFail = {
  ok: false;
  reason: "too_small" | "email_mismatch" | "empty_memories";
  detail: string;
};

export function validateDump(
  dump: BackupDump,
  bufBytes: number,
  expectedEmail: string | undefined,
  minBytes = DEFAULT_MIN_BYTES,
): BackupValidationOk | BackupValidationFail {
  if (bufBytes < minBytes) {
    return {
      ok: false,
      reason: "too_small",
      detail: `dump is ${bufBytes} bytes, expected ≥ ${minBytes}`,
    };
  }
  if (expectedEmail && dump.user.email !== expectedEmail) {
    return {
      ok: false,
      reason: "email_mismatch",
      detail: `user.email=${dump.user.email} but expected ${expectedEmail}`,
    };
  }
  if ((dump.counts.memories ?? 0) <= 0) {
    return {
      ok: false,
      reason: "empty_memories",
      detail: `counts.memories=${dump.counts.memories ?? 0}`,
    };
  }
  return { ok: true, bytes: bufBytes };
}

export type RunDailyBackupOpts = {
  /** For tests: skip the real Drive client and capture the upload call. */
  driveOverride?: DriveLike;
  /** For tests: alternate DB. */
  poolOverride?: ClientLike;
  /** For tests: override webhook sender. */
  notify?: typeof notifyJob;
  /** For tests: override "today" used in the filename. */
  now?: Date;
};

/**
 * Top-level executor called by the job runner. Returns detail to be persisted
 * on kioku_job_runs.detail. Throws only on error states the runner should
 * persist as status='error' and alert on.
 */
export async function runDailyBackup(
  opts: RunDailyBackupOpts = {},
): Promise<Record<string, unknown>> {
  const userIdRaw = process.env.BACKUP_USER_ID ?? "";
  const userId = parseInt(userIdRaw, 10);
  if (!userId || Number.isNaN(userId)) {
    throw new Error("daily-backup: BACKUP_USER_ID env missing or invalid");
  }
  const expectedEmail = process.env.BACKUP_EXPECTED_EMAIL || undefined;
  const minBytes = process.env.BACKUP_MIN_BYTES
    ? parseInt(process.env.BACKUP_MIN_BYTES, 10) || DEFAULT_MIN_BYTES
    : DEFAULT_MIN_BYTES;
  const notify = opts.notify ?? notifyJob;
  const now = opts.now ?? new Date();

  const dump = await dumpUserForBackup(userId, opts.poolOverride);
  const json = JSON.stringify(dump);
  const buf = Buffer.from(json, "utf8");

  const validation = validateDump(dump, buf.byteLength, expectedEmail, minBytes);
  if (!validation.ok) {
    // Alert and throw — runner will persist status='error'.
    await notify({
      severity: "critical",
      title: "KIOKU daily backup aborted — validation failed",
      detail: `reason=${validation.reason}: ${validation.detail}`,
      context: {
        userId,
        dump_bytes: buf.byteLength,
        dump_counts: dump.counts,
        user_email_in_dump: dump.user.email,
      },
    });
    throw new Error(`validation:${validation.reason}:${validation.detail}`);
  }

  const ymd = (() => {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  })();
  const filename = `kioku-id${userId}-${ymd}.json`;

  let uploadResult;
  try {
    uploadResult = await uploadBufferToDrive(filename, buf, {
      mimeType: "application/json",
      driveOverride: opts.driveOverride,
    });
  } catch (err: any) {
    await notify({
      severity: "critical",
      title: "KIOKU daily backup — Drive upload failed",
      detail: String(err?.message ?? err ?? "unknown"),
      context: { userId, filename, dump_bytes: buf.byteLength },
    });
    throw err;
  }

  logger.info(
    {
      component: "jobs",
      job: DAILY_BACKUP_JOB_ID,
      userId,
      filename,
      dump_bytes: buf.byteLength,
      drive_id: uploadResult.id,
    },
    "[jobs] daily backup uploaded",
  );

  return {
    userId,
    filename,
    dump_bytes: buf.byteLength,
    dump_counts: dump.counts,
    drive_file_id: uploadResult.id,
    drive_file_name: uploadResult.name,
    drive_url: uploadResult.webViewLink ?? null,
  };
}

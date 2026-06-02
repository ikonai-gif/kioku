---
name: kioku-deliberation-sessions
description: Conventions for the kioku_deliberation_sessions table and its archive/retention lifecycle. Use when reading or modifying deliberation storage, session visibility, archiving, or deletion.
---

# KIOKU — deliberation sessions storage

## Table `kioku_deliberation_sessions`
- `id` is **TEXT**, e.g. `dlb_10_1780154753618` (not serial).
- All timestamps are **milliseconds** (`Date.now()`): `started_at`, `completed_at`.
- `room_id` INTEGER, `status` ∈ `running` | `completed` | `failed`.
- `models_used` TEXT default `'[]'` — the real models that participated (used to
  prove no silent substitution; see kioku-agent-routing).
- `archived_at` BIGINT — `NULL` = visible; set = soft-archived.

DDL is managed by **idempotent raw SQL in `server/storage.ts`** (around the
bootstrap block), NOT by `migrations/`. Add columns/indexes with
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` there.

## Retention lifecycle (archive → delete)
1. **Archive** (reversible soft-archive): keep the newest 5 finished sessions per
   room visible; archive the rest. Runs per-session on new-session start AND via a
   daily scheduler backstop. Never touches `running`. Methods:
   `archiveOldRoomSessions(roomId, keep=5)`, `archiveAllRoomsOldSessions(keep=5)`,
   `archiveDeliberationSession(id)`, `restoreDeliberationSession(id)`,
   `getVisibleDeliberationsByRoom(roomId)`, `getArchivedDeliberationsByRoom(roomId)`.
2. **Delete** (hard): `deleteOldArchivedSessions(retentionDays=90)` deletes
   archived sessions older than the cutoff and logs each row into
   `deliberation_session_deletion_log`. Single atomic CTE (DELETE … RETURNING →
   INSERT log). Gated by env **`DELIBERATION_DELETE_ENABLED`** in the scheduler —
   default OFF, so it is a no-op in prod until BOSS flips it.

## Invariants
- Only archived rows are ever deleted; never running/visible.
- Archive-then-delete keeps a 90-day window after a session is archived.
- The deletion log is the audit trail — keep writing to it.

-- ────────────────────────────────────────────────────────────────────────────
-- 0004_w9_turn_state_down.sql — Rollback for W9 Item 2 turn-state additions.
--
-- Safe-rollback order:
--   1. Coerce any in-flight 'turn_in_progress' meetings to 'aborted' so the
--      narrower CHECK re-applies cleanly. Same for any 'private' context
--      rows — reassigned to 'scoped' with empty scope (effectively invisible
--      to agents, preserves author_agent_id for forensics). Zero-row cases
--      are no-ops.
--   2. Drop indexes that reference columns we are about to remove.
--   3. Drop turn_records (cascades no FK — turn_records.meeting_id ON DELETE
--      CASCADE is the child side).
--   4. Drop current_turn_id, next_participant_id from meetings.
--   5. Re-narrow both CHECK constraints.
--
-- This script is idempotent — run twice is a no-op after the first.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1a. Coerce turn_in_progress meetings → aborted before we narrow the CHECK.
UPDATE meetings
   SET state    = 'aborted',
       metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('abort_reason', 'migration_0004_rollback',
                                        'aborted_at', now())
 WHERE state = 'turn_in_progress';

-- 1b. Coerce 'private' rows → 'scoped' with empty scope so the narrow CHECK re-applies.
UPDATE meeting_context
   SET visibility       = 'scoped',
       scope_agent_ids  = '[]'::jsonb
 WHERE visibility = 'private';

-- 2. Drop helper indexes.
DROP INDEX IF EXISTS idx_meetings_current_turn;
DROP INDEX IF EXISTS idx_tr_started_at_running;
DROP INDEX IF EXISTS idx_tr_meeting_state;

-- 3. Drop turn_records table.
DROP TABLE IF EXISTS turn_records;

-- 4. Drop new columns on meetings.
ALTER TABLE meetings DROP COLUMN IF EXISTS current_turn_id;
ALTER TABLE meetings DROP COLUMN IF EXISTS next_participant_id;

-- 5a. Re-narrow meetings.state CHECK (remove 'turn_in_progress').
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_state_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_state_check
  CHECK (state IN (
    'pending',
    'active',
    'waiting_for_turn',
    'waiting_for_approval',
    'completed',
    'aborted'
  ));

-- 5b. Re-narrow meeting_context.visibility CHECK (remove 'private').
ALTER TABLE meeting_context DROP CONSTRAINT IF EXISTS meeting_context_visibility_check;
ALTER TABLE meeting_context ADD CONSTRAINT meeting_context_visibility_check
  CHECK (visibility IN ('all', 'owner', 'scoped'));

COMMIT;

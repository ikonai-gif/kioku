-- ────────────────────────────────────────────────────────────────────────────
-- 0004_w9_turn_state.sql — W9 Item 2: Turn Runner state + idempotency fence
-- Description: Adds turn-state tracking columns to `meetings`, introduces
--              `turn_records` table, widens `meeting_context.visibility`
--              CHECK to include 'private' (MCM + FakeDb already forward-compat
--              per W9 Item 1), and widens `meetings.state` CHECK to include
--              `turn_in_progress` so the two-tx runner can park a meeting
--              while the LLM call is in flight.
--
-- Invariants introduced:
--   - `next_participant_id` on `meetings` — atomic round-robin pointer.
--     NULL at creation / end-of-round / approval-pending-with-no-next.
--   - `current_turn_id` on `meetings` — the active turn_records row id, if
--     any. Set in T1, cleared in T2 commit OR reaper abort.
--   - `turn_records` — one row per turn attempt. `state='running'` rows older
--     than 120s are aborted by the reaper; the reaper uses the per-row
--     `started_at` (NOT the meeting-level metadata) so timing signal is
--     durable even across app restarts.
--
-- Visibility widening: MCM shipped 'private' handling in code (Item 1
-- forward-compat). The FakeDb test harness emulates 'private' at the unit
-- level, but the Postgres CHECK constraint must widen BEFORE Item 5 writes
-- any 'private' rows to prod. This migration lands in Item 2 (one migration,
-- multiple concerns — cheaper than splitting).
--
-- Rollback: see 0004_w9_turn_state_down.sql. Columns dropped, table dropped,
-- visibility CHECK reverts to original set. `turn_in_progress` rows in
-- `meetings.state` at rollback time are coerced to 'aborted' first by the
-- down script so the narrower CHECK re-applies cleanly.
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. meetings: new columns ─────────────────────────────────────────────────
ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS next_participant_id UUID NULL REFERENCES meeting_participants(id) ON DELETE SET NULL;

ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS current_turn_id UUID NULL;

-- Partial index: most lookups are "is there an in-flight turn for this meeting?"
-- Keeps the index narrow (few rows have non-NULL current_turn_id at any time).
CREATE INDEX IF NOT EXISTS idx_meetings_current_turn
  ON meetings(current_turn_id) WHERE current_turn_id IS NOT NULL;

-- ── 2. meetings.state CHECK: add 'turn_in_progress' ──────────────────────────
-- Drop-and-recreate because CHECK constraints cannot be ALTERed in place.
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_state_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_state_check
  CHECK (state IN (
    'pending',
    'active',
    'turn_in_progress',
    'waiting_for_turn',
    'waiting_for_approval',
    'completed',
    'aborted'
  ));

-- ── 3. meeting_context.visibility CHECK: add 'private' ───────────────────────
-- MCM (Item 1) already filters 'private' correctly in code; this widens the
-- Postgres-level CHECK so Item 5's artifact/consolidation path can insert
-- 'private' rows. Authors see their own; other agents see rows only when
-- explicitly in `scope_agent_ids`.
ALTER TABLE meeting_context DROP CONSTRAINT IF EXISTS meeting_context_visibility_check;
ALTER TABLE meeting_context ADD CONSTRAINT meeting_context_visibility_check
  CHECK (visibility IN ('all', 'owner', 'scoped', 'private'));

-- ── 4. turn_records ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS turn_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id      UUID NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id  UUID NOT NULL REFERENCES meeting_participants(id),
  sequence_fence  BIGINT NOT NULL,
  state           VARCHAR(20) NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'completed', 'failed')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ NULL,
  error           TEXT NULL
);

-- Composite index: reaper + per-meeting turn inspection
CREATE INDEX IF NOT EXISTS idx_tr_meeting_state
  ON turn_records(meeting_id, state);

-- Partial index on running rows by start time — reaper does
-- `WHERE state='running' AND started_at < now() - 120s`. Partial keeps it
-- tiny (only in-flight turns, typically 0-1 per meeting).
CREATE INDEX IF NOT EXISTS idx_tr_started_at_running
  ON turn_records(started_at) WHERE state = 'running';

-- 0021_rls_phase1.sql — [LUCA-086 / BRO2] RLS Phase 1: memories + rooms.
-- Defense-in-depth under existing app-level WHERE user_id filters.
-- FORCE is mandatory: the app pool connects as the table owner (LUCA-086 fix #2).
-- Rollback: see 0021_rls_phase1_down.sql (single DISABLE per table).

ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memories_user_isolation ON memories;
CREATE POLICY memories_user_isolation ON memories
  USING (
    -- PR1 incremental adoption: when 'app.user_id' is UNSET (all legacy call sites),
    -- current_setting(..., true) returns NULL -> COALESCE '' -> policy passes (no behavior change).
    -- When SET (withRLS-wrapped paths), only the owner's rows are visible.
    -- NOTE [BRO2 fix #5 to LUCA-086]: spec's bare current_setting()='' comparison
    -- yields NULL (not true) when unset -> would hide ALL rows from legacy paths.
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rooms_user_isolation ON rooms;
CREATE POLICY rooms_user_isolation ON rooms
  USING (
    -- PR1 incremental adoption: when 'app.user_id' is UNSET (all legacy call sites),
    -- current_setting(..., true) returns NULL -> COALESCE '' -> policy passes (no behavior change).
    -- When SET (withRLS-wrapped paths), only the owner's rows are visible.
    -- NOTE [BRO2 fix #5 to LUCA-086]: spec's bare current_setting()='' comparison
    -- yields NULL (not true) when unset -> would hide ALL rows from legacy paths.
    COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

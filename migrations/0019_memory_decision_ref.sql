-- 0019_memory_decision_ref.sql
-- Phase 0 (room-decision honesty layer): add a nullable decision_ref to memories.
-- Links a provenance='room_decision' memory to the meeting that produced it
-- (= meetings.id), from which participants are derived via meeting_participants.
-- Additive, reversible, safe on populated tables (no default, no rewrite).
--
-- NUMBERING CAVEAT: this R&D clone tops out at 0017; per our records 0018 is
-- already applied to Neon prod. Reconcile the next-free number against prod
-- before applying. BOSS applies all prod DB writes.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS decision_ref uuid;

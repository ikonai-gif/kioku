-- Phase 3: Cross-session Decision Provenance Chain
-- Links decisions across deliberation sessions to track how one decision influenced another.

ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS parent_decision_id TEXT;
ALTER TABLE kioku_deliberation_sessions ADD COLUMN IF NOT EXISTS provenance_chain TEXT DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_delib_parent_decision ON kioku_deliberation_sessions(parent_decision_id);

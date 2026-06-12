-- 0024_skills_v2.sql — [LUCA-089 / BRO2] Skills PR1: user_id + RLS from day one,
-- auto-creation metadata. Existing prod rows keep user_id=NULL = global
-- (Boss-seeded) skills visible to everyone. The old table-wide UNIQUE(name)
-- is replaced by a per-user namespace; NULLS NOT DISTINCT (PG15+) keeps the
-- global namespace unique too.

ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE;
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS trigger_pattern TEXT;
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS auto_created BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS tool_sequence TEXT NOT NULL DEFAULT '[]';
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE luca_skills DROP CONSTRAINT IF EXISTS luca_skills_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS luca_skills_user_name_key ON luca_skills (user_id, name) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_luca_skills_user_category ON luca_skills(user_id, category, name);
CREATE INDEX IF NOT EXISTS idx_luca_skills_agent ON luca_skills(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_luca_skills_auto ON luca_skills(auto_created, use_count DESC) WHERE auto_created = TRUE;

ALTER TABLE luca_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE luca_skills FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skills_user_isolation ON luca_skills;
CREATE POLICY skills_user_isolation ON luca_skills
  USING (
    user_id IS NULL
    OR COALESCE(current_setting('app.user_id', true), '') = ''
    OR user_id = NULLIF(current_setting('app.user_id', true), '')::int
  );

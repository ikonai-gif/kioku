-- Down migration for 0024_skills_v2.sql. Columns are kept (no data loss);
-- RLS and the per-user uniqueness are reverted.
ALTER TABLE luca_skills DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS skills_user_isolation ON luca_skills;
DROP INDEX IF EXISTS luca_skills_user_name_key;
ALTER TABLE luca_skills ADD CONSTRAINT luca_skills_name_key UNIQUE (name);

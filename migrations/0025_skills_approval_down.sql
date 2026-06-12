-- Down migration for 0025_skills_approval.sql
ALTER TABLE luca_skills DROP COLUMN IF EXISTS approved_at;

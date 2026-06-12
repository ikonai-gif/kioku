-- 0025_skills_approval.sql — [LUCA-089 Part 4 / BRO2] Skills PR2: Boss review
-- flow. Pending = auto_created = TRUE AND approved_at IS NULL. Manually
-- created and Boss-seeded skills are active without approval.

ALTER TABLE luca_skills ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

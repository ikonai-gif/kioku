-- Down migration for 0016_luca_skills.sql
DROP INDEX IF EXISTS idx_luca_skills_category_name;
DROP TABLE IF EXISTS luca_skills;

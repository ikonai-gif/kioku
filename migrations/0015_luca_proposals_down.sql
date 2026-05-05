-- Down migration for 0015_luca_proposals.sql
DROP INDEX IF EXISTS idx_luca_proposals_user_created;
DROP INDEX IF EXISTS idx_luca_proposals_status_created;
DROP INDEX IF EXISTS idx_luca_proposals_user_status_created;
DROP TABLE IF EXISTS luca_proposals;

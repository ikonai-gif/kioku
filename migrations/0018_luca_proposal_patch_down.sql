-- Down migration for 0018_luca_proposal_patch.sql
ALTER TABLE luca_proposals DROP COLUMN IF EXISTS test_report;
ALTER TABLE luca_proposals DROP COLUMN IF EXISTS patch_diff;

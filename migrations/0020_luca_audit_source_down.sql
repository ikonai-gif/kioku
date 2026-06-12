-- Down migration for 0020_luca_audit_source.sql
ALTER TABLE luca_audit_log DROP COLUMN IF EXISTS job_id;
ALTER TABLE luca_audit_log DROP COLUMN IF EXISTS source;

-- Down migration for 0019_luca_audit_auto_mode.sql
ALTER TABLE luca_audit_log DROP COLUMN IF EXISTS auto_mode;

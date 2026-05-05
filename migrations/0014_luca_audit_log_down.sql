-- Reverse of 0014_luca_audit_log.sql. Drops the audit table and indexes.
DROP INDEX IF EXISTS idx_luca_audit_blocked;
DROP INDEX IF EXISTS idx_luca_audit_input_hash;
DROP INDEX IF EXISTS idx_luca_audit_tool_created;
DROP INDEX IF EXISTS idx_luca_audit_user_created;
DROP TABLE IF EXISTS luca_audit_log;

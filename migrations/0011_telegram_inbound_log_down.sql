-- Rollback for 0011_telegram_inbound_log.sql
-- Drops index first, then table.

DROP INDEX IF EXISTS idx_telegram_inbound_chat_time;
DROP TABLE IF EXISTS telegram_inbound_log;

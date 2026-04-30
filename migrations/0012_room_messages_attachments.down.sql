-- 0012 down: remove room_messages.attachments / search_text + indexes
DROP INDEX IF EXISTS idx_room_messages_search_text;
DROP INDEX IF EXISTS idx_room_messages_attachments_nonempty;
ALTER TABLE room_messages DROP COLUMN IF EXISTS search_text;
ALTER TABLE room_messages DROP COLUMN IF EXISTS attachments;

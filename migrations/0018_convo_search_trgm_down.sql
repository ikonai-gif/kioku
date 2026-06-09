DROP INDEX IF EXISTS idx_room_messages_search_text_trgm;
DROP INDEX IF EXISTS idx_room_messages_content_trgm;
-- pg_trgm extension left in place (may be used elsewhere); drop manually if needed.

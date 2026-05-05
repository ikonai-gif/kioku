-- ────────────────────────────────────────────────────────────────────────────
-- 0017_fabrication_probes_expand_down.sql — R473-full BRO2 (rollback)
--
-- Removes the 12 probes seeded by 0017_fabrication_probes_expand.sql.
-- Kept narrowly scoped by name so we never touch unrelated rows. Cascade
-- on kioku_fabrication_test_runs is FK-defined so historical run rows
-- linked to these probe ids are also removed.
-- ────────────────────────────────────────────────────────────────────────────

DELETE FROM kioku_fabrication_probes
 WHERE name IN (
   'fake_local_file',
   'fake_chapter_request',
   'fake_user_doc',
   'fake_image_no_attachment',
   'fake_memory_count',
   'fake_namespace_query',
   'fake_user_history',
   'fake_tool_count',
   'fake_voice_provider',
   'fake_email_send',
   'fake_calendar_create',
   'fake_language_excuse'
 );

-- Meeting Room Track A — Week 1 ROLLBACK / DOWN Migration
-- Author: Kote Kavelashvili <kote@ikonbai.com>
-- Date: 2026-04-20
-- Description: Reverses the Week 1 meeting room schema migration.
--              Drops all new tables and removes room_type column.
-- WARNING: This will permanently DELETE all data in meeting_* tables.
--          Only run on staging or if a production rollback is explicitly approved.

-- Drop new tables in dependency order (most dependent first)
DROP TABLE IF EXISTS meeting_artifacts;
DROP TABLE IF EXISTS meeting_context;
DROP TABLE IF EXISTS meeting_participant_profiles;
DROP TABLE IF EXISTS meeting_participants;
DROP TABLE IF EXISTS meetings;

-- Drop the global sequence
DROP SEQUENCE IF EXISTS meeting_context_seq_global;

-- Remove room_type column from rooms table
ALTER TABLE rooms DROP COLUMN IF EXISTS room_type;

-- =====================================================================
-- KIOKU bi-temporal validity — Phase 2.1a foundation (additive, inert)
-- Author: BRO2 | 2026-06-02 | Spec: [BRO2-325]
-- RUN BY: BOSS ONLY. Additive only: ADD COLUMN + CREATE INDEX + backfill.
-- No DELETE, no destructive op. Idempotent (safe to re-run).
--
-- Adds: valid_from/valid_to (epoch-ms valid time) + fact_key.
-- This migration is INERT: it does not change retrieval or invalidate anything.
-- Auto-invalidation (2.1b) and retrieval filtering (2.1c) ship separately.
-- =====================================================================

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- 1. columns (idempotent)
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_from bigint;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS valid_to   bigint;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS fact_key   text;

-- 2. backfill valid_from = created_at for existing rows (idempotent: only NULLs).
--    valid_to stays NULL (= still valid). Uniform backfill is harmless for
--    non-factual rows (they are never invalidated; validity logic is scoped
--    to factual namespaces in code).
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;

-- 3. indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_memories_user_ns_validto
  ON memories (user_id, namespace, valid_to);
CREATE INDEX IF NOT EXISTS idx_memories_user_factkey
  ON memories (user_id, fact_key) WHERE fact_key IS NOT NULL;

-- 4. verification (review before COMMIT)
\echo '--- rows with valid_from populated (expect = total) ---'
SELECT count(*) FILTER (WHERE valid_from IS NOT NULL) AS with_valid_from,
       count(*) AS total
FROM memories;

\echo '--- valid_to should be all NULL right after 2.1a (expect 0 closed) ---'
SELECT count(*) AS closed_facts FROM memories WHERE valid_to IS NOT NULL;

\echo '--- fact_key still empty until Luca starts writing it (expect 0) ---'
SELECT count(*) AS with_fact_key FROM memories WHERE fact_key IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------------
-- ROLLBACK (after COMMIT), if ever needed — drops the additive columns:
--   ALTER TABLE memories DROP COLUMN IF EXISTS fact_key;
--   ALTER TABLE memories DROP COLUMN IF EXISTS valid_to;
--   ALTER TABLE memories DROP COLUMN IF EXISTS valid_from;
--   DROP INDEX IF EXISTS idx_memories_user_ns_validto;
--   DROP INDEX IF EXISTS idx_memories_user_factkey;
-- (Drop only once schema.ts is reverted, else drizzle push would re-add.)
-- ---------------------------------------------------------------------

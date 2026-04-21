-- W7 P2.3 — Unify agent LLM routing fields
-- Author: Kote Kavelashvili <kote@ikonbai.com>
-- Date: 2026-04-21
-- Description:
--   The `agents` table has three overlapping columns for LLM routing:
--     - `model` (legacy, top-level)
--     - `llm_model` (introduced when per-agent provider support landed)
--     - `llm_provider`
--   Luca's row (id=16) had model="gpt-5.4-mini", llm_model="claude-sonnet-4-6",
--   llm_provider="openai" — three fields disagreeing. The diagnostic is in
--   luca_diagnostic_2026-04-21.md.
--
--   This migration makes `llm_model` + `llm_provider` + `llm_api_key` the
--   canonical triple and sunsets `model`:
--     1. Backfill: COPY model → llm_model WHERE llm_model IS NULL
--        (preserves rows that only had the legacy field set).
--     2. Null-out: UPDATE agents SET model = NULL
--        (forces all reads to consult llm_model only).
--
--   The `model` column is NOT dropped in this migration — the Drizzle schema
--   still declares it for one release (compat shim on the PATCH endpoint in
--   server/routes.ts). A follow-up migration will drop the column after the
--   compat window closes.
--
-- Safe to run multiple times (idempotent — re-running is a no-op).
-- Reversible: see 0002_unify_agent_model_fields_down.sql.

BEGIN;

-- 1. Backfill: copy any non-null `model` into llm_model when llm_model is unset.
UPDATE agents
   SET llm_model = model
 WHERE llm_model IS NULL
   AND model IS NOT NULL;

-- 2. Null-out the legacy `model` column so it is never read as authoritative.
UPDATE agents
   SET model = NULL
 WHERE model IS NOT NULL;

COMMIT;

-- W7 P2.3 DOWN — Revert unify-agent-model-fields migration
-- Author: Kote Kavelashvili <kote@ikonbai.com>
-- Date: 2026-04-21
--
-- This DOWN is intentionally PARTIAL. The UP migration (a) backfilled
-- llm_model from model, (b) nulled `model`. We cannot unambiguously
-- recover which rows were backfilled in step (a) vs. which had both
-- fields set before UP ran.
--
-- DOWN simply mirrors llm_model into model for rows where model is
-- currently null and llm_model is not — re-establishing the pre-UP
-- visibility of the legacy field. That matches the rollback intent of
-- "legacy readers should see a non-null model again."
--
-- Mismatched-triple rows (like Luca's original state) will NOT be
-- restored to their exact prior values — that was the bug this
-- migration fixed.
--
-- Safe to run multiple times.

BEGIN;

UPDATE agents
   SET model = llm_model
 WHERE model IS NULL
   AND llm_model IS NOT NULL;

COMMIT;

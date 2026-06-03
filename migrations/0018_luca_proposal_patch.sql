-- ────────────────────────────────────────────────────────────────────────────
-- 0018_luca_proposal_patch.sql — R471 (BRO2): Phase-1 of Luca's gated build loop
--
-- Description: Add two NULLABLE, inert columns to luca_proposals so Luca can
--              attach a concrete unified diff (patch_diff) plus the output of
--              tests SHE ran in her own luca_run_code sandbox (test_report) to
--              a self-improvement proposal.
--
-- Boundary (per BOSS, 2026-06-03): "дай ему всё что он попросил КРОМЕ того
--   чтобы он мог сам себя строить или ещё что-либо делать без моего согласия."
--   This migration enables Luca to PROPOSE a patch with evidence. It does NOT:
--     - create any git branch or PR (no GitHub write here),
--     - auto-apply anything (status flow stays pending→approved|rejected;
--       BOSS decides via POST /api/luca/proposals/:id/decide),
--     - touch any other table.
--   Phase-2 (actual branch+PR via GitHub API) is intentionally a separate,
--   guardrail-heavy change and is NOT part of this migration.
--
-- Safety / inertness:
--   - Both columns are NULLABLE with no default → existing rows + existing
--     INSERTs (which omit them) are completely unaffected.
--   - ADD COLUMN IF NOT EXISTS → idempotent, safe to re-run.
--   - No data backfill, no constraint changes, no index changes.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE luca_proposals ADD COLUMN IF NOT EXISTS patch_diff  text;
ALTER TABLE luca_proposals ADD COLUMN IF NOT EXISTS test_report text;

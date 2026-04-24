-- ────────────────────────────────────────────────────────────────────────────
-- 0008_baseline_observed_firing.sql — persist observed-firing set on baseline
--
-- BRO1 M-4 (PR #62): baseline must retain which tools actually fired in the
-- 24h window leading up to each snapshot so that silent-regression drift
-- detection is meaningful across runs. Without this, getPreviousObservedTools
-- always returned empty and tool_went_silent never fired.
--
-- Additive column, default '[]' — back-fills existing baselines with an empty
-- observed set. Schema version stays 1.0 (pure data addition, no behavior
-- change for reads that don't know about this column).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE kioku_capabilities_baseline
  ADD COLUMN IF NOT EXISTS observed_firing JSONB NOT NULL DEFAULT '[]'::jsonb;

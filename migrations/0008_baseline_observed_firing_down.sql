-- Rollback for 0008_baseline_observed_firing.sql
ALTER TABLE kioku_capabilities_baseline DROP COLUMN IF EXISTS observed_firing;

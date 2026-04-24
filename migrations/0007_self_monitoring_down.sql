-- Downgrade for 0007_self_monitoring.sql
DROP TABLE IF EXISTS kioku_fabrication_test_runs;
DROP TABLE IF EXISTS kioku_fabrication_probes;
DROP TABLE IF EXISTS kioku_capabilities_drift_log;
DROP TABLE IF EXISTS kioku_capabilities_baseline;
ALTER TABLE rooms DROP COLUMN IF EXISTS visible_in_ui;
ALTER TABLE rooms DROP COLUMN IF EXISTS purpose;

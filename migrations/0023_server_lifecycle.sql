-- 0023_server_lifecycle.sql — [LUCA-088 / BRO2] CRON PR2: server start/shutdown
-- tracking so the startup missed-run checker can distinguish crash from deploy.

CREATE TABLE IF NOT EXISTS server_lifecycle (
  id          SERIAL PRIMARY KEY,
  event       TEXT NOT NULL,
  timestamp   BIGINT NOT NULL,
  version     TEXT,
  hostname    TEXT
);
CREATE INDEX IF NOT EXISTS idx_lifecycle_event_ts ON server_lifecycle(event, timestamp DESC);

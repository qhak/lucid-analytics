-- Session replay: one summary row per recorded visit. The recording itself
-- (rrweb events) lives in the R2 bucket bound as REPLAYS, keyed
-- <site>/<id>/<seq>-<pageKey>. Rows and objects are removed by the daily
-- cron after RETENTION_DAYS (src/replays.js). Times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS replay_sessions (
  id          TEXT PRIMARY KEY,        -- random per-tab ID from tracker.js
  site        TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  pages       INTEGER NOT NULL DEFAULT 1,
  clicks      INTEGER NOT NULL DEFAULT 0,
  chunks      INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  entry_path  TEXT,
  last_path   TEXT,
  country     TEXT,
  browser     TEXT,
  os          TEXT,
  device      TEXT
);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_site_last ON replay_sessions (site, last_at);
CREATE INDEX IF NOT EXISTS idx_replay_sessions_last ON replay_sessions (last_at);

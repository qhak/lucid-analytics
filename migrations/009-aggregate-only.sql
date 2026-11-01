-- Future analytics writes use independent daily totals only. There is no
-- visitor ID, session ID, event timestamp, properties blob or cross-dimension
-- row. Existing `events` rows remain untouched as historical data.
CREATE TABLE IF NOT EXISTS daily_analytics (
  site          TEXT NOT NULL,
  day           TEXT NOT NULL,
  metric        TEXT NOT NULL CHECK (metric IN ('pageview', 'action', 'revenue')),
  dimension     TEXT NOT NULL,
  value         TEXT NOT NULL DEFAULT '',
  count         INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  revenue_minor INTEGER NOT NULL DEFAULT 0 CHECK (revenue_minor >= 0),
  PRIMARY KEY (site, day, metric, dimension, value)
);

CREATE INDEX IF NOT EXISTS idx_daily_analytics_site_day
  ON daily_analytics (site, day, metric, dimension);

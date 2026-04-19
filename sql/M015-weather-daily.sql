-- M015 — weather_daily table
--
-- Stores observed/forecast weather per business per day. Populated by the
-- backfill endpoint (/api/admin/weather/backfill) on first run, then by the
-- daily master-sync going forward.
--
-- Used by:
--   - AI weekly manager memo (upcoming forecast)
--   - Scheduling AI suggestion (weather-adjusted target hours)
--   - Anomaly detection (suppress false positives on weather-explained dips)
--   - /weather correlation page (sales by weather bucket)
--
-- Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS weather_daily (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date          DATE NOT NULL,

  temp_min      NUMERIC,
  temp_max      NUMERIC,
  temp_avg      NUMERIC,
  precip_mm     NUMERIC,
  wind_max      NUMERIC,

  weather_code  INTEGER,   -- WMO code from Open-Meteo
  summary       TEXT,      -- human-readable ("Rain", "Overcast", "Clear")

  source        TEXT DEFAULT 'open-meteo',
  is_forecast   BOOLEAN DEFAULT false,  -- true if date is in future when written

  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (business_id, date)
);

CREATE INDEX IF NOT EXISTS weather_daily_business_date_idx
  ON weather_daily (business_id, date DESC);

ALTER TABLE weather_daily ENABLE ROW LEVEL SECURITY;

-- Members of an org can read weather for their businesses
DROP POLICY IF EXISTS "weather_daily_select_own" ON weather_daily;
CREATE POLICY "weather_daily_select_own" ON weather_daily
  FOR SELECT
  USING (
    business_id IN (
      SELECT b.id FROM businesses b
      JOIN organisation_members m ON m.org_id = b.org_id
      WHERE m.user_id = auth.uid()
    )
  );

-- Writes go through service role only (from sync engine + backfill endpoint).
-- No INSERT/UPDATE policy — service role bypasses RLS.

-- Auto-update updated_at on mutation
CREATE OR REPLACE FUNCTION weather_daily_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS weather_daily_updated_at ON weather_daily;
CREATE TRIGGER weather_daily_updated_at
  BEFORE UPDATE ON weather_daily
  FOR EACH ROW EXECUTE FUNCTION weather_daily_touch_updated_at();

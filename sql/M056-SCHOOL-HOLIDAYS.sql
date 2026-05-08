-- M056 — school_holidays table
--
-- DDL only. Pre-laid for Piece 3 batch 2 (sportlov / höstlov / summer
-- vacation lookup) per architecture Section 7. Schema captures dates by
-- kommun (Swedish municipality code) since school holidays vary
-- regionally — Stockholm's sportlov week differs from Göteborg's.
--
-- The Skolverket scraper is NOT part of Piece 0. This migration creates
-- the table so the column shape is settled; Piece 3 batch 2 ships the
-- scraper code + populates the rows.
--
-- Schema notes:
--   - kommun stored as 4-digit string (Stockholm = '0180', Göteborg =
--     '1480' etc.) to match `businesses.kommun` from M054.
--   - lan kept separate so we can fall back to län-level holidays for
--     kommuner where Skolverket doesn't publish per-kommun dates.
--   - source records WHERE we got the data ('skolverket' for Pieces 3+,
--     'manual_override' for operator-set rows in case the scraper
--     missed something).
--   - UNIQUE(kommun, start_date, name) prevents double-imports if the
--     scraper retries after a partial failure.
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream F.1).
--
-- Run: open Supabase SQL Editor, paste this file, run.

CREATE TABLE IF NOT EXISTS school_holidays (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kommun      TEXT        NOT NULL,
  lan         TEXT        NOT NULL,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  name        TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kommun, start_date, name)
);

-- Lookup index — Piece 3 batch 2 will query "is this date inside any
-- school holiday for this business's kommun?" — the (kommun, start_date,
-- end_date) shape supports range queries on (start_date <= ? AND
-- end_date >= ?) WHERE kommun = ? efficiently.
CREATE INDEX IF NOT EXISTS idx_school_holidays_lookup
  ON school_holidays (kommun, start_date, end_date);

-- Sanity: confirm the table exists and is empty (DDL only — scraper lands later).
SELECT COUNT(*) AS school_holiday_rows FROM school_holidays;

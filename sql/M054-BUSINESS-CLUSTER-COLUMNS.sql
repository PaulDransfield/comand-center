-- M054 — businesses cluster columns + Vero pre-population
--
-- Adds four cluster-membership columns to `businesses` so the prediction
-- system (Pieces 4-5) can group similar businesses for cross-customer
-- learning ("Italian places in Stockholm city centre, medium-sized")
-- without scraping anything from sales data.
--
-- Why pre-populate now: with one customer (Vero) and two businesses,
-- there are no peer businesses to derive clusters from. Manual values
-- get filled in immediately so the schema is exercised; cluster-derived
-- features in Pieces 4-5 read from these rather than guessing.
--
-- Operator can correct values during the Vero anomaly triage call.
--
-- See PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md Appendix Z (Stream F.1).
--
-- Run: open Supabase SQL Editor, paste this file, run.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS cuisine          TEXT,
  ADD COLUMN IF NOT EXISTS location_segment TEXT,
  ADD COLUMN IF NOT EXISTS size_segment     TEXT,
  ADD COLUMN IF NOT EXISTS kommun           TEXT;

-- Vero Italiano — Italian sit-down restaurant
UPDATE businesses
SET cuisine          = 'italian',
    location_segment = 'city_center',
    size_segment     = 'medium',
    kommun           = '0180'  -- Stockholm kommun
WHERE id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99';

-- Rosali Deli — deli/café format, smaller footprint than Vero Italiano
UPDATE businesses
SET cuisine          = 'deli',
    location_segment = 'city_center',
    size_segment     = 'small',
    kommun           = '0180'
WHERE id = '97187ef3-b816-4c41-9230-7551430784a7';

-- Sanity: confirm both Vero rows have all four columns populated.
SELECT id, name, cuisine, location_segment, size_segment, kommun
FROM businesses
WHERE id IN (
  '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99',
  '97187ef3-b816-4c41-9230-7551430784a7'
);

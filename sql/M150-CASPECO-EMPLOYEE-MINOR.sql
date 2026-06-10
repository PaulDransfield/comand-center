-- M150 — derived age fields on caspeco_employees.
--
-- Chicce runs on Caspeco (not Personalkollen), and the Caspeco roster
-- (caspeco_employees, 84 rows) already carries the personnummer in
-- personal_identity. This adds the DERIVED age fields so under-18 staff are
-- detectable without re-exposing the PII:
--   · birth_date — parsed from personal_identity (date only, no id digits)
--   · is_minor   — birth_date < 18 years ago
-- Populated on every Caspeco sync (lib/sync/engine.ts) via the shared
-- personnummer parser; this migration also backfills the rows already synced.
--
-- NOTE: this is the DATA foundation. The scheduling compliance engine reads
-- staff_profiles, which Caspeco does not yet feed (the grid is PK-shaped);
-- wiring Caspeco → staff_profiles/staff_shifts is a separate piece.
--
-- Idempotent.

ALTER TABLE public.caspeco_employees
  ADD COLUMN IF NOT EXISTS birth_date date;
ALTER TABLE public.caspeco_employees
  ADD COLUMN IF NOT EXISTS is_minor boolean NOT NULL DEFAULT false;

-- One-time backfill from the personnummer already on file. Mirrors the TS
-- parser in lib/scheduling/personnummer.ts (12-digit YYYYMMDD, 10-digit with
-- century inference, samordningsnummer day+60, invalid dates rejected).
WITH parsed AS (
  SELECT
    id,
    CASE WHEN length(regexp_replace(personal_identity,'\D','','g')) = 12
           THEN substr(regexp_replace(personal_identity,'\D','','g'),1,4)::int
         WHEN length(regexp_replace(personal_identity,'\D','','g')) = 10
           THEN CASE WHEN ('20'||substr(regexp_replace(personal_identity,'\D','','g'),1,2))::int <= extract(year from now())::int
                     THEN ('20'||substr(regexp_replace(personal_identity,'\D','','g'),1,2))::int
                     ELSE ('19'||substr(regexp_replace(personal_identity,'\D','','g'),1,2))::int END
    END AS yr,
    CASE WHEN length(regexp_replace(personal_identity,'\D','','g')) = 12 THEN substr(regexp_replace(personal_identity,'\D','','g'),5,2)::int
         WHEN length(regexp_replace(personal_identity,'\D','','g')) = 10 THEN substr(regexp_replace(personal_identity,'\D','','g'),3,2)::int END AS mo,
    CASE WHEN length(regexp_replace(personal_identity,'\D','','g')) = 12 THEN substr(regexp_replace(personal_identity,'\D','','g'),7,2)::int
         WHEN length(regexp_replace(personal_identity,'\D','','g')) = 10 THEN substr(regexp_replace(personal_identity,'\D','','g'),5,2)::int END AS dy_raw
  FROM public.caspeco_employees
  WHERE personal_identity IS NOT NULL
),
clean AS (
  SELECT id, yr, mo, (CASE WHEN dy_raw > 60 THEN dy_raw - 60 ELSE dy_raw END) AS dy
  FROM parsed
  WHERE yr IS NOT NULL AND mo BETWEEN 1 AND 12
),
dated AS (
  SELECT id, make_date(yr, mo, dy) AS birth
  FROM clean
  WHERE dy BETWEEN 1 AND 31
)
UPDATE public.caspeco_employees ce
SET birth_date = d.birth,
    is_minor   = (age(d.birth) < interval '18 years')
FROM dated d
WHERE ce.id = d.id;

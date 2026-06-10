-- M151 — Phase 1 of the Caspeco scheduling integration
-- (docs/CASPECO-SCHEDULING-INTEGRATION-PLAN.md).
--
-- 1. businesses.scheduling_source — which roster system feeds the canonical
--    scheduling grid ('personalkollen' | 'caspeco'). Drives the source-aware
--    skin (Phase 3) and disambiguates if a business connects both.
-- 2. Bring the Caspeco roster into the canonical staff_profiles table (the
--    grid/AI/compliance read this, not caspeco_employees), keyed by
--    pk_staff_url = 'caspeco-<id>' (mirrors the staff_logs caspeco-<id>
--    convention). is_minor/birth_date (M150) flow straight through.
--
-- Ongoing maintenance is done by lib/scheduling/caspeco-sync.ts on each
-- Caspeco sync; this migration backfills what's already synced (Chicce: 84).
-- Idempotent.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS scheduling_source text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='businesses_scheduling_source_chk') THEN
    ALTER TABLE public.businesses
      ADD CONSTRAINT businesses_scheduling_source_chk
      CHECK (scheduling_source IS NULL OR scheduling_source IN ('personalkollen','caspeco'));
  END IF;
END $$;

-- Mark Caspeco businesses (those with a synced Caspeco roster) when unset.
UPDATE public.businesses b
SET scheduling_source = 'caspeco'
WHERE b.scheduling_source IS NULL
  AND EXISTS (SELECT 1 FROM public.caspeco_employees ce WHERE ce.business_id = b.id);

-- Roster → canonical staff_profiles.
INSERT INTO public.staff_profiles
  (org_id, business_id, pk_staff_url, staff_uid, display_name, full_name, email,
   is_minor, birth_date, hired_at, contract_end_at, is_active, last_refreshed_at)
SELECT
  ce.org_id, ce.business_id,
  'caspeco-'||ce.caspeco_employee_id, 'caspeco-'||ce.caspeco_employee_id,
  NULLIF(ce.full_name,''), NULLIF(ce.full_name,''), ce.email,
  ce.is_minor, ce.birth_date, ce.employment_start_date, ce.employment_end_date,
  ce.is_active, now()
FROM public.caspeco_employees ce
ON CONFLICT (business_id, pk_staff_url) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  full_name         = EXCLUDED.full_name,
  email             = EXCLUDED.email,
  is_minor          = EXCLUDED.is_minor,
  birth_date        = EXCLUDED.birth_date,
  hired_at          = EXCLUDED.hired_at,
  contract_end_at   = EXCLUDED.contract_end_at,
  is_active         = EXCLUDED.is_active,
  last_refreshed_at = now();

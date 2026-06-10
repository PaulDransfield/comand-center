-- M149 — per-business Swedish labour config + per-staff minor flag.
--
-- Powers the scheduling compliance layer (lib/scheduling/labor-rules-sweden.ts):
--   · businesses.scheduling_labor_config — JSONB LaborConfig: which collective
--     agreement binds the business ('visita_hrf' | 'hangavtal_hrf' | 'none')
--     and whether the minderår (under-18) protections are enforced. NULL =
--     fall back to DEFAULT_LABOR_CONFIG (Visita–HRF, minors off).
--   · staff_profiles.is_minor — effective under-18 flag the compliance engine
--     reads. Owner-settable; auto-derived from birth_date on PK/Caspeco sync
--     when a birth date is available.
--   · staff_profiles.birth_date — authoritative age source when the staff feed
--     (PK personnummer / Caspeco) exposes it. NULL when not disclosed → is_minor
--     stays whatever the owner set.
--
-- Idempotent. Applied 2026-06-10.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS scheduling_labor_config jsonb;

ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS is_minor boolean NOT NULL DEFAULT false;

ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS birth_date date;

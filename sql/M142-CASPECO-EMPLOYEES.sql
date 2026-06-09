-- M142 — caspeco_employees
--
-- Caspeco's /api/v1/Employees endpoint returns ~84 rows per company for
-- Chicce: id, employeeNumber, personalIdentity, name, employments[]
-- with contracts, professions and station IDs. None of this fits
-- staff_logs (that's shifts, not roster), so we persist the roster in
-- its own table.
--
-- Why this matters: when booking.getall permission unlocks, every
-- reservation will reference employee_id; without the roster we have
-- no way to attribute. Persisting now means the day permissions land
-- the bookings sync is one-step ready.
--
-- PII: personalIdentity is Swedish personal number — DO NOT expose
-- in any non-admin surface. Stored encrypted-at-rest by Supabase but
-- our app layer treats it as PII.
--
-- Idempotent. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.caspeco_employees (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id              UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  -- Caspeco identifiers
  caspeco_employee_id      INTEGER NOT NULL,
  caspeco_company_id       UUID NOT NULL,
  caspeco_employee_number  INTEGER,
  -- Identity
  first_name               TEXT,
  last_name                TEXT,
  full_name                TEXT GENERATED ALWAYS AS (
    COALESCE(NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), ''), '')
  ) STORED,
  personal_identity        TEXT,                  -- Swedish personal number (PII)
  email                    TEXT,
  -- Current employment snapshot (most recent active employment)
  current_employment_id    INTEGER,
  current_contract_id      UUID,
  current_profession_id    INTEGER,
  current_station_id       INTEGER,               -- the Caspeco station they're rostered to
  employment_start_date    DATE,
  employment_end_date      DATE,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  -- Raw payload preserved so we can re-derive fields without re-syncing
  raw_payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Audit
  last_synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One row per Caspeco employee within a CommandCenter business
  CONSTRAINT caspeco_employees_unique
    UNIQUE (business_id, caspeco_employee_id)
);

CREATE INDEX IF NOT EXISTS caspeco_employees_business_idx
  ON public.caspeco_employees (business_id);

CREATE INDEX IF NOT EXISTS caspeco_employees_company_idx
  ON public.caspeco_employees (caspeco_company_id);

-- Updated-at trigger
CREATE OR REPLACE FUNCTION public.caspeco_employees_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS caspeco_employees_touch_updated_at ON public.caspeco_employees;
CREATE TRIGGER caspeco_employees_touch_updated_at
  BEFORE UPDATE ON public.caspeco_employees
  FOR EACH ROW EXECUTE FUNCTION public.caspeco_employees_touch_updated_at();

-- RLS — tenant scoped via org_id
ALTER TABLE public.caspeco_employees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS caspeco_employees_select ON public.caspeco_employees;
CREATE POLICY caspeco_employees_select ON public.caspeco_employees
  FOR SELECT TO authenticated
  USING (org_id = ANY(current_user_org_ids()));

COMMENT ON TABLE public.caspeco_employees IS
  'M142 — Caspeco employee roster per CommandCenter business. Persisted as part of the Caspeco sync so reservations (once booking.getall lands) can be attributed to specific employees.';
COMMENT ON COLUMN public.caspeco_employees.personal_identity IS
  'Swedish personal number — PII. Never expose in non-admin surfaces.';

COMMIT;

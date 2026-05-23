-- M081 — Setup-health summary + VAT filing cadence on businesses
--
-- Phase 2 of the Day-1 onboarding work. Two columns landed together:
--
-- 1. setup_health_summary (jsonb) — Cached output of the readiness
--    validator (lib/integrations/fortnox-readiness.ts). Updated on every
--    readiness check call. Lets the dashboard render a "Setup Health"
--    badge instantly without re-running the 3 s check on every page load.
--    Shape:
--      {
--        "overall": "ok" | "warn" | "fail" | "pending",
--        "ready_to_use": true | false,
--        "counts": { "ok": 8, "warn": 1, "fail": 0, "pending": 1 },
--        "failing_checks": [{ "key": "...", "label": "...", "detail": "..." }],
--        "evaluated_at": "2026-05-23T..."
--      }
--
-- 2. vat_filing_cadence (text) — How often the customer files VAT to
--    Skatteverket. Drives the default scope of the momsrapport surface.
--    Allowed values:
--      'monthly'   — turnover > 40 MSEK or voluntary
--      'quarterly' — most restaurants (1-40 MSEK)
--      'annually'  — turnover < 1 MSEK
--    NULL = not yet configured. Readiness check warns until set.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS setup_health_summary    jsonb,
  ADD COLUMN IF NOT EXISTS setup_health_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS vat_filing_cadence      text;

ALTER TABLE businesses
  DROP CONSTRAINT IF EXISTS businesses_vat_filing_cadence_check;

ALTER TABLE businesses
  ADD CONSTRAINT businesses_vat_filing_cadence_check
  CHECK (vat_filing_cadence IS NULL OR vat_filing_cadence IN ('monthly', 'quarterly', 'annually'));

-- Index so the dashboard widget can quickly find businesses with non-ok
-- setup health for "issues across your org" rollup.
CREATE INDEX IF NOT EXISTS businesses_setup_health_overall_idx
  ON businesses ((setup_health_summary ->> 'overall'))
  WHERE setup_health_summary IS NOT NULL;

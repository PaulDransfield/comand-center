-- ═══════════════════════════════════════════════════════════════════════
-- M115 — tracker_line_items.subcategory backfill from BAS dictionary
-- ═══════════════════════════════════════════════════════════════════════
--
-- Phase B of the invoice-organisation work. Populates the
-- tracker_line_items.subcategory field for rows where subcategory IS NULL
-- but fortnox_account IS NOT NULL, using a static BAS → operator-bucket
-- mapping mirrored from lib/overheads/basBuckets.ts.
--
-- ── DRY-RUN-PREDICTED FIGURES (from scripts/diag-bas-bucket-step0.mjs) ─
--
--   Chicce: 365 of 561 rows resolve (65.1 %); 0 honest-incomplete leftover.
--   Vero:   246 of 446 rows resolve (55.2 %); 0 honest-incomplete leftover.
--   Total: 611 rows enriched.
--
-- ── KEEP IN SYNC ──────────────────────────────────────────────────────
--
-- This CASE WHEN MUST match lib/overheads/basBuckets.ts. When you add or
-- change a row there, mirror it here AND re-run the dry-run script to
-- verify the counts match. Drift produces backfilled rows that disagree
-- with newly-ingested ones.
--
-- ── IDEMPOTENT ────────────────────────────────────────────────────────
--
-- WHERE subcategory IS NULL — re-running is a no-op on already-populated
-- rows. The AI extractor sets sensible subcategories at write time when
-- it can; this backfill only fills the gaps the AI left blank.
--
-- ── HOW TO RUN ────────────────────────────────────────────────────────
--
-- 1. Paste into Supabase SQL Editor. Default DRY (BEGIN…ROLLBACK).
--    V1 should match the dry-run predicted figures above.
-- 2. Once verified, flip ROLLBACK to COMMIT and re-run to persist.

BEGIN;

-- ── PRE-SANITY ─────────────────────────────────────────────────────────
SELECT '── PRE-SANITY: rows about to flip ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  COUNT(*) AS would_resolve
FROM public.tracker_line_items
WHERE subcategory IS NULL
  AND fortnox_account IS NOT NULL
GROUP BY business_id
ORDER BY 1;

-- ── OPERATION — Apply the dictionary ──────────────────────────────────
--
-- Mirror of lib/overheads/basBuckets.ts. Same shape: 80 accounts grouped
-- by decade. Unknown accounts (NULL from the CASE) leave the column
-- unchanged — honest-incomplete preserved per the prompt's hard rule.
UPDATE public.tracker_line_items
SET subcategory = CASE fortnox_account::text
  -- 30xx — Revenue subsets
  WHEN '3004' THEN 'other_revenue'
  WHEN '3010' THEN 'alcohol'
  WHEN '3019' THEN 'dine_in'
  WHEN '3051' THEN 'dine_in'
  WHEN '3052' THEN 'alcohol'
  -- 3053 deliberately NOT mapped — VAT hotfix invariant: 6 % never
  -- implies takeaway. See lib/overheads/basBuckets.ts comment.
  WHEN '3560' THEN 'other_revenue'
  WHEN '3740' THEN 'other_revenue'
  WHEN '3980' THEN 'other_revenue'
  WHEN '3993' THEN 'other_revenue'
  WHEN '3995' THEN 'other_revenue'
  WHEN '3996' THEN 'other_revenue'
  WHEN '3999' THEN 'other_revenue'

  -- 50xx — Premises
  WHEN '5010' THEN 'rent'
  WHEN '5011' THEN 'rent'
  WHEN '5012' THEN 'rent'
  WHEN '5013' THEN 'rent'
  WHEN '5020' THEN 'utilities'
  WHEN '5060' THEN 'cleaning'
  WHEN '5062' THEN 'cleaning'
  WHEN '5070' THEN 'security_alarm'
  WHEN '5090' THEN 'other_premises'

  -- 51xx — Water/waste/maintenance
  WHEN '5160' THEN 'utilities'
  WHEN '5170' THEN 'repairs'

  -- 52xx — Equipment rental
  WHEN '5220' THEN 'equipment_rental'

  -- 54xx — IT / consumables / cleaning chemicals
  WHEN '5410' THEN 'it_hardware'
  WHEN '5420' THEN 'it_software'
  WHEN '5460' THEN 'consumables'
  WHEN '5461' THEN 'consumables'
  WHEN '5465' THEN 'consumables'
  WHEN '5480' THEN 'consumables'

  -- 55xx — Repairs
  WHEN '5500' THEN 'repairs'
  WHEN '5520' THEN 'repairs'
  WHEN '5580' THEN 'repairs'

  -- 56xx — Vehicle / delivery
  WHEN '5611' THEN 'vehicle'
  WHEN '5613' THEN 'vehicle'
  WHEN '5615' THEN 'vehicle'
  WHEN '5619' THEN 'vehicle'
  WHEN '5620' THEN 'delivery'
  WHEN '5690' THEN 'delivery'

  -- 57xx — Freight
  WHEN '5700' THEN 'delivery'
  WHEN '5710' THEN 'delivery'

  -- 58xx — Travel
  WHEN '5800' THEN 'travel'

  -- 59xx — Marketing / sales
  WHEN '5900' THEN 'marketing'
  WHEN '5910' THEN 'marketing'
  WHEN '5930' THEN 'marketing'
  WHEN '5970' THEN 'marketing'
  WHEN '5990' THEN 'marketing'

  -- 60xx — Marketing + representation
  WHEN '6031' THEN 'marketing'
  WHEN '6040' THEN 'marketing'
  WHEN '6050' THEN 'marketing'
  WHEN '6060' THEN 'marketing'
  WHEN '6070' THEN 'representation'
  WHEN '6071' THEN 'representation'
  WHEN '6072' THEN 'representation'

  -- 62xx — Telephone / internet
  WHEN '6200' THEN 'telephone_internet'
  WHEN '6212' THEN 'telephone_internet'
  WHEN '6230' THEN 'telephone_internet'

  -- 63xx — Insurance + alarm
  WHEN '6310' THEN 'insurance'
  WHEN '6370' THEN 'security_alarm'

  -- 64xx — Audit
  WHEN '6420' THEN 'audit'

  -- 65xx — Professional services
  WHEN '6530' THEN 'accounting'
  WHEN '6540' THEN 'it_services'
  WHEN '6550' THEN 'consulting'
  WHEN '6560' THEN 'professional_other'
  WHEN '6570' THEN 'bank_fees'
  WHEN '6590' THEN 'consulting'
  WHEN '6591' THEN 'consulting'

  -- 68xx + 69xx — External services, bank, admin
  -- 6800 → consulting (BAS calls this "memberships" but Vero uses it
  -- for agency staff ~144k SEK/year; consulting is the closest fit
  -- for external-service spend across customers).
  WHEN '6800' THEN 'consulting'
  WHEN '6910' THEN 'memberships'
  WHEN '6950' THEN 'bank_fees'
  WHEN '6991' THEN 'bank_fees'
  WHEN '6992' THEN 'other_admin'

  -- 70xx — Wages
  WHEN '7010' THEN 'salaries'
  WHEN '7011' THEN 'salaries'
  WHEN '7012' THEN 'salaries'
  WHEN '7081' THEN 'holiday_pay'
  WHEN '7090' THEN 'salaries'

  -- 73xx — Benefits
  WHEN '7380' THEN 'personnel_benefits'

  -- 75xx — Social security
  WHEN '7510' THEN 'payroll_tax'
  WHEN '7519' THEN 'payroll_tax'
  WHEN '7570' THEN 'pension'
  WHEN '7590' THEN 'pension'

  -- 76xx — Personnel
  WHEN '7601' THEN 'personnel_benefits'
  WHEN '7621' THEN 'training'
  WHEN '7632' THEN 'personnel_benefits'
  WHEN '7690' THEN 'personnel_benefits'

  ELSE NULL  -- unknown account: leave column unchanged (honest-incomplete)
END
WHERE subcategory IS NULL
  AND fortnox_account IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════

SELECT '── V1 ── Newly-populated rows by business + bucket ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  subcategory,
  COUNT(*) AS rows,
  ROUND(SUM(amount)::numeric, 0) AS spend
FROM public.tracker_line_items
WHERE subcategory IS NOT NULL
  AND fortnox_account IS NOT NULL
GROUP BY business_id, subcategory
ORDER BY 1, 4 DESC;

SELECT '── V2 ── Honestly-uncategorised leftover (subcategory still NULL after backfill) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  COUNT(*) FILTER (WHERE fortnox_account IS NULL)    AS no_account_rows,
  COUNT(*) FILTER (WHERE fortnox_account IS NOT NULL) AS unknown_account_rows
FROM public.tracker_line_items
WHERE subcategory IS NULL
GROUP BY business_id
ORDER BY 1;

SELECT '── V3 ── Sample of unknown-account rows (if any — extend dictionary?) ──' AS section;
SELECT
  CASE business_id
    WHEN '63ada0ac-18af-406a-8ad3-4acfd0379f2c'::uuid THEN 'Chicce'
    WHEN '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'::uuid THEN 'Vero'
  END AS business,
  fortnox_account,
  COUNT(*) AS rows,
  ROUND(SUM(amount)::numeric, 0) AS spend
FROM public.tracker_line_items
WHERE subcategory IS NULL
  AND fortnox_account IS NOT NULL
GROUP BY business_id, fortnox_account
ORDER BY 4 DESC NULLS LAST
LIMIT 20;

-- ═══════════════════════════════════════════════════════════════════════
-- DRY RUN — discard everything. To APPLY: change ROLLBACK to COMMIT.
-- ═══════════════════════════════════════════════════════════════════════
ROLLBACK;

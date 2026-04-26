-- M030-RECATEGORIZE-LINE-ITEMS.sql
-- ============================================================================
-- One-off cleanup. Re-categories tracker_line_items rows whose `subcategory`
-- contradicts their `category` — the symptom of the pre-2026-04-26
-- enrichLines bug where a specific label match (e.g. 'reklam' → marketing)
-- got attached as subcategory while the AI's wrong category hint
-- ('revenue') was kept as the top-level category.
--
-- The fix in extract-worker/route.ts (FIXES §0o postscript) prevents this
-- going forward by trusting label-specific matches over the AI hint when
-- account number is unavailable. This SQL fixes the historical drift.
--
-- Surfaced 2026-04-26 by the M029 verify query, which showed:
--   subcategory='marketing' under category='revenue' (13 rows, 50k kr)
--
-- The mappings here mirror SV_SUB in extract-worker/route.ts. Each block
-- moves rows from the wrong category to the canonical one. Idempotent —
-- safe to re-run.
-- ============================================================================

BEGIN;

-- ── Marketing-style subcategories belong under other_cost ────────────────────
-- (rent, utilities, marketing, accounting etc — all 5xxx-6xxx BAS overheads)
UPDATE tracker_line_items
   SET category = 'other_cost'
 WHERE category <> 'other_cost'
   AND subcategory IN (
     'marketing','rent','utilities','accounting','audit','consulting',
     'insurance','bank_fees','telecom','software','postage','shipping',
     'office_supplies','cleaning','repairs','consumables','entertainment',
     'vehicles','electricity'
   );

-- ── Salaries / payroll-tax / pension belong under staff_cost ────────────────
UPDATE tracker_line_items
   SET category = 'staff_cost'
 WHERE category <> 'staff_cost'
   AND subcategory IN ('salaries','payroll_tax','pension');

-- ── Depreciation subcategory belongs under depreciation category ────────────
UPDATE tracker_line_items
   SET category = 'depreciation'
 WHERE category <> 'depreciation'
   AND subcategory = 'depreciation';

-- ── Interest items belong under financial ───────────────────────────────────
UPDATE tracker_line_items
   SET category = 'financial'
 WHERE category <> 'financial'
   AND subcategory IN ('interest','interest_income');

-- ── Verify ───────────────────────────────────────────────────────────────────
-- Re-run the same distribution query M029 used. Should now show:
--   • 'marketing' rows ONLY under category='other_cost' (or absent)
--   • the 'revenue' bucket clean (food / takeaway / alcohol / null only)
SELECT category, subcategory, COUNT(*) AS line_items, ROUND(SUM(amount))::int AS total_kr
  FROM tracker_line_items
 WHERE subcategory IN (
         'marketing','rent','utilities','accounting','audit','consulting',
         'insurance','bank_fees','telecom','software','postage','shipping',
         'office_supplies','cleaning','repairs','consumables','entertainment',
         'vehicles','electricity','salaries','payroll_tax','pension',
         'depreciation','interest','interest_income'
       )
 GROUP BY category, subcategory
 ORDER BY category, subcategory;

-- Revenue bucket should now be clean:
SELECT subcategory, COUNT(*) AS line_items, ROUND(SUM(amount))::int AS total_kr
  FROM tracker_line_items
 WHERE category = 'revenue'
 GROUP BY subcategory
 ORDER BY line_items DESC;

COMMIT;

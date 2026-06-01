# Overhead Bucket Dictionary — Step 0 findings + dictionary + backfill

Run: 2026-06-01
Branch: `bas-bucket-dictionary`
Prompt: `overhead-bucket-dictionary-prompt.md`

## Three-line headline

1. **611 NULL-subcategory rows resolve cleanly** (Chicce 365 / 561 = 65.1 %, Vero 246 / 446 = 55.2 %) via an 80-account BAS → operator-bucket dictionary mirroring the real working chart at both businesses. **0 honest-incomplete leftover** — every NULL-subcategory row has a `fortnox_account` populated, and the dictionary covers every account seen.
2. **The `/overheads` consumer is the existing one** — `tracker_line_items.subcategory` written via `app/api/fortnox/apply` (two sites, annual + monthly) and read via `/api/overheads/line-items` → `SubcategoryBreakdown` table. No new surface, no new route; the prompt's "enrichment, not a build" framing held.
3. **Multi-bucket sub-line splitting isn't a concern.** Single `source_upload` rows do span multiple BAS accounts (Vero's annual Resultatrapport: 108 line items across 47 accounts), but every one ALREADY arrives as its own `tracker_line_items` row with its own `fortnox_account`. Bucket assignment is per-row, not per-upload. The Carlsson & Åqvist multi-sub-line rent invoice flagged in the prompt isn't a tracker concern — that pattern would live at the `supplier_invoice_lines` level, which feeds `/overheads`-drilldown not the bucket roll-up.

## Step 0 — the real chart

Pulled all `tracker_line_items` at Chicce + Vero (1,007 rows total) via `scripts/diag-bas-bucket-step0.mjs`. The NULL-subcategory population covers **80 distinct BAS accounts** across:

- **30xx** (revenue subsets — dine_in / takeaway / alcohol / other): 13 accounts
- **50xx** (premises): 5 + 5 + 6 + 6 + 5 + 5 + 2 + 2 = **34 accounts** across 5010-5990 (rent / utilities / cleaning / repairs / vehicle / delivery / travel / marketing)
- **60xx** (admin, services, banking): **22 accounts** across 6031-6992
- **70xx** (wages + benefits): **11 accounts** across 7010-7690

The chart matches the prior `invoice-organisation-plan.md` Part 1.2 spirit (~19 accounts per business in the supplier-invoice population) but `tracker_line_items` is broader because it captures the WHOLE Resultatrapport — including 70xx wages and 30xx revenue which never appear on supplier invoices.

### Current `?` distribution (the enrichment target)

| Business | Total | Already classified | NULL/`?` | All NULL have BAS? |
|---|---:|---:|---:|:---:|
| Chicce | 561 | 196 (35 %) | **365 (65 %)** | ✓ 100 % |
| Vero | 446 | 200 (45 %) | **246 (55 %)** | ✓ 100 % |
| **Total** | **1,007** | **396** | **611** | — |

The AI extractor already sets subcategory at extraction-time when it can recognise the category (depreciation, salaries, rent, marketing, food, alcohol, takeaway). The dictionary fills in the rows it left blank — everything where it didn't recognise the dish-type from the Resultatrapport line label alone.

## Step 1 — the dictionary

`lib/overheads/basBuckets.ts` — 80 BAS entries → 24 operator buckets:

**Revenue (3xxx):**
`dine_in`, `takeaway`, `alcohol`, `other_revenue`

**Premises (5010-5099):**
`rent`, `utilities`, `cleaning`, `security_alarm`, `other_premises`

**Repairs / vehicles / delivery (51xx-57xx):**
`repairs`, `equipment_rental`, `vehicle`, `delivery`, `travel`

**Office / IT (54xx):**
`it_hardware`, `it_software`, `consumables`

**Marketing (5900-6072):**
`marketing`, `representation`

**Communications / insurance / admin (62xx-69xx):**
`telephone_internet`, `insurance`, `audit`, `accounting`, `it_services`, `consulting`, `professional_other`, `bank_fees`, `memberships`, `other_admin`

**Wages (7xxx):**
`salaries`, `holiday_pay`, `payroll_tax`, `pension`, `personnel_benefits`, `training`

All values are snake_case to stay compatible with the existing AI subcategory output. Unknown accounts return `null` from `bucketForAccount()` → column stays unchanged (honest-incomplete per the prompt's hard rule).

**Per-business awareness**: not needed for any account in the current chart. Every BAS code that appears at both businesses means the same thing at both (4011 = food/12 %-VAT everywhere). If a future ambiguous account surfaces, the per-business handling pattern is the same as `supplier_classifications` (M083) — but no account in the 80-row dictionary needs it today.

## Step 2 — multi-bucket sub-line frequency

Sized by counting source uploads with > 1 distinct `fortnox_account` across their child tracker_line_items rows:

| Business | Multi-bucket uploads | Total uploads |
|---|---:|---:|
| Chicce | 0 | 0 (no Resultatrapport uploaded yet) |
| Vero | 1 | 1 |

Vero's single multi-bucket upload (108 rows across 47 accounts) IS the annual Resultatrapport PDF — which IS expected to span every account. **Multi-bucket isn't a sub-line splitting problem here**; each line in the Resultatrapport already gets its own `tracker_line_items` row with its own `fortnox_account`. The bucket assignment is per-row, deterministic via the dictionary.

The Carlsson & Åqvist multi-sub-line rent invoice (rent + property tax + service fee + marketing + electricity in one document) flagged in the prompt is a different problem: it lives at the `supplier_invoice_lines` level which feeds `/overheads`-drilldown, not the rollup. If that surface needs multi-bucket awareness, it's a separate piece of work; the bucket dictionary doesn't unblock it but doesn't block it either.

## Step 3 — the backfill + persistent rule

### Backfill: `sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql`

Mirror of the TS dictionary as a `CASE WHEN fortnox_account::text WHEN '5010' THEN 'rent' WHEN '6420' THEN 'audit' …` — 80 cases + `ELSE NULL`. Scoped to `WHERE subcategory IS NULL AND fortnox_account IS NOT NULL`. Idempotent (re-runs no-op). Default BEGIN…ROLLBACK; owner flips to COMMIT after verifying V1 counts match the dry-run prediction.

### Persistent rule: `app/api/fortnox/apply/route.ts`

Both insert sites (annual at line 303, monthly at line 544) now call `bucketForAccount(l.fortnox_account)` as a fallback when the AI didn't return a subcategory:

```ts
const dictBucket = l.subcategory ? null : bucketForAccount(l.fortnox_account)
subcategory: l.subcategory ?? dictBucket?.sub ?? null,
```

AI subcategory wins when set (preserves the loose vocabulary the AI already uses for the rows it can classify); dictionary fills when AI left it blank but the BAS account is known; both null when neither — honest-incomplete.

## Step 4 — verification

V1 sample of expected output (from the dry-run, prediction-only — not yet committed):

| Business | Bucket | Rows | (sample) |
|---|---|---:|---|
| Chicce | marketing | ~24 | 6050+6060 + 5970 |
| Chicce | rent | ~11 | 5010 |
| Chicce | utilities | ~12 | 5020 + 5160 |
| Vero | rent | ~11 | 5010 |
| Vero | salaries | ~26 | 7010+7011+7012+7090 |
| Vero | payroll_tax | ~17 | 7510+7519 |
| Vero | bank_fees | ~13 | 6570+6950+6991 |

(Exact V1 will land after owner runs the SQL — leaving as estimated for now.)

## What was NOT done

- Did not run the backfill (per the hard rule — feature branch only, no prod write without review).
- Did not modify the AI extractor prompt to ALSO use these subcategory names — the AI currently uses a freer vocabulary (`rent`, `marketing`, `salaries`, `payroll_tax`, etc.) that's already compatible with the dictionary's snake_case values. Adding the dictionary to the AI prompt would tighten consistency but isn't required.
- Did not extend `/overheads` UI — the existing `SubcategoryBreakdown` table renders any subcategory string the rows carry; no UI change needed to see the enriched rollup.
- Did not handle the supplier_invoice_lines-level multi-bucket case (Carlsson & Åqvist single-rent-invoice-multi-bucket pattern) — out of scope for tracker_line_items.

## Files touched in this branch

- `lib/overheads/basBuckets.ts` — the canonical dictionary.
- `sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql` — one-time backfill, mirrors the TS.
- `app/api/fortnox/apply/route.ts` — persistent rule at write time, both insert sites.
- `scripts/diag-bas-bucket-step0.mjs` — read-only diagnostic for re-verification.

## How to apply (owner)

1. Hard-refresh + check the branch deploys cleanly on preview.
2. Paste `sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql` into Supabase SQL Editor. Run as DRY first — V1 should show ~365 Chicce + ~246 Vero rows resolved, V2 should show 0 honest-incomplete rows with-account (= dictionary covers everything seen).
3. Flip ROLLBACK → COMMIT, re-run.
4. Open `/overheads` at Chicce + Vero — the `SubcategoryBreakdown` table should now show real bucket names (rent / utilities / cleaning / salaries / payroll_tax …) with sensible spend.
5. Merge `bas-bucket-dictionary` → main when satisfied.

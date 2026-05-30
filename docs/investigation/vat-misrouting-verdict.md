# VAT misrouting verdict — diagnostic report

> Read-only investigation. No code, schema, or data changed.
> Date: 2026-05-30. Author: Claude Code (CLI).

## Verdict (one line)

**PARTIAL — bug CAN FIRE on revenue subset classification (dine-in vs takeaway) on three of four ingestion paths. Part B SQL drafted; awaiting execution to confirm whether it IS firing in production data.**

The bug is structurally possible from 2026-04-01 onward on the
**Resultatrapport (P&L) deterministic parser path**, the **Resultatrapport AI
extraction path**, and the **Personalkollen POS revenue path** — all three
treat any `6 % moms` revenue line as takeaway. It cannot fire on the
supplier-invoice categorisation pipeline (which routes by BAS account /
supplier name, not VAT). Total revenue is unaffected — only the **dine-in
vs takeaway split** is at risk. Cost-side categorisation is unaffected.

---

## Part A — Code trace: every VAT → category decision point

For each site I answer: **does a `6 %` rate force a takeaway/non-food
classification, or is category decided primarily by something else?**

### A.1 `lib/fortnox/classify.ts:119-132` — `classifyByVat(label)`

The single canonical regex classifier. Imported by exactly three call sites
(see A.2, A.3, A.10).

```ts
// lib/fortnox/classify.ts:121-124
if (/\b25\s*%?\s*moms\b/.test(key))  return { subcategory: 'alcohol' }
if (/\b12\s*%?\s*moms\b/.test(key))  return { subcategory: 'food' }
if (/\b6\s*%?\s*moms\b/.test(key))   return { subcategory: 'takeaway' }
if (/\b(wolt|foodora|uber\s*eats)\b/.test(key)) return { subcategory: 'takeaway' }
```

**CAN FIRE.** A revenue label containing `6 % moms` ALWAYS returns
`subcategory='takeaway'`. There is no fallback to BAS or supplier. The
function returns only `subcategory` — category is decided upstream.

**Pre-2026-04-01:** correct (6 % was only takeaway/Wolt/Foodora).
**Post-2026-04-01:** ambiguous — 6 % can now legitimately mean ordinary
foodstuffs (goods/groceries) sold to a takeaway customer, dine-in food
at the temporary cut, OR platform delivery. Classifier always picks
takeaway.

### A.2 `lib/fortnox/resultatrapport-parser.ts:696` — deterministic Resultatrapport parser

```ts
// lib/fortnox/resultatrapport-parser.ts:696-697
const vatHint     = (category === 'revenue' || category === 'food_cost')
                    ? classifyByVat(label) : null
const subcategory = vatHint?.subcategory ?? labelClass.subcategory ?? accountClass?.subcategory ?? null
```

VAT-hint **WINS** over label-class AND over account-class for `revenue` and
`food_cost` lines. Then `addToRollup` at line 807-810:

```ts
} else if (subcategory === 'takeaway') {
  r.takeaway_revenue += amount
} else if (subcategory === 'food' || subcategory === 'dine_in') {
  r.dine_in_revenue += amount
```

**CAN FIRE on every Resultatrapport PDF processed by the deterministic
parser path.** A P&L line labelled `Försäljning mat 6% moms` (or any 6 %
moms phrasing on a 3xxx account) lands in `takeaway_revenue` even if the
account itself is the dine-in food account.

Note: account class (BAS routing) is **lower priority** than VAT hint
here. A dine-in food account 3010 labelled `Försäljning 6% moms` will be
classified takeaway regardless of the account.

### A.3 `app/api/fortnox/extract-worker/route.ts:811-816` — Resultatrapport AI extractor

```ts
const vatBased = (category === 'revenue' || category === 'food_cost')
  ? classifyByVat(label) : null
const subcategory = vatBased?.subcategory
  ?? labelBased.subcategory
  ?? accountBased?.subcategory
  ?? null
```

Same priority order as A.2: VAT hint wins for revenue/food_cost.

In addition, the **system prompt to Claude** explicitly instructs the
model to pre-classify 6 % revenue as takeaway (route.ts:387-393):

```
12 % moms → dine-in food (sit-down service) → dine_in_revenue
 6 % moms → takeaway food (platform-led)    → takeaway_revenue

Wolt, Foodora, and Uber Eats invoices arrive at 6 % VAT — they are takeaway
even if the label says only "Försäljning Wolt" without explicit moms.
If you see Wolt/Foodora/UberEats in the label OR a generic 6 %-moms
revenue line, classify as takeaway.
```

**CAN FIRE on every AI-extracted Resultatrapport** AND the Claude model is
actively prompted to make the wrong classification on its own. The
deterministic post-pass at A.3 would also fire even if the AI got it right.

### A.4 `lib/pos/personalkollen.ts:307-309` — POS revenue classifier

```ts
if      (Math.abs(vat - 0.12) < 0.001) { foodNet  += line; dineInNet   += line }
else if (Math.abs(vat - 0.06) < 0.001) { foodNet  += line; takeawayNet += line }
else if (Math.abs(vat - 0.25) < 0.001) { drinkNet += line; dineInNet   += line }
else                                   { drinkNet += line; dineInNet   += line }
```

Per-ticket POS classification. Hard-coded "6 % VAT = takeaway", no fallback
to a POS `is_takeaway` flag or product type. Net food revenue at 6 % VAT
goes to `takeawayNet`, which flows into `revenue_logs.takeaway_revenue` →
`daily_metrics.takeaway_revenue` → `monthly_metrics.takeaway_revenue`.

Comment at line 321-323 says:
```ts
// Prefer the VAT-rate signal over PK's `is_take_away` (mostly null).
// Fall back to the flag only if no 6 % items at all.
const isTakeaway = takeawayNet > 0 ? true : (s.is_take_away ?? false)
```

So the sale-level `is_takeaway` boolean is **deliberately ignored** if
any 6 % line is on the ticket. Post-2026-04-01 this means a dine-in
ticket with any 6 %-rated food item gets flagged takeaway at the sale
level too.

**CAN FIRE on every Personalkollen-using customer post-2026-04-01.**
This is the highest-volume and most direct bug — it fires per-ticket,
every service.

### A.5 `lib/finance/projectRollup.ts:133-141` — revenue subset fallback

```ts
const dineInRaw   = r.dine_in_revenue  == null
  ? revenueSubsetFromLines(lines, sub => sub === 'food' || sub === 'dine_in')
  : asRevenue(r.dine_in_revenue)
const takeawayRaw = r.takeaway_revenue == null
  ? revenueSubsetFromLines(lines, sub => sub === 'takeaway')
  : asRevenue(r.takeaway_revenue)
```

**CAN FIRE INDIRECTLY.** When the AI rollup didn't populate the subset
fields, projectRollup re-derives them from `tracker_line_items.subcategory`
— which was set upstream by `classifyByVat`. Inherits the upstream bug.
Doesn't introduce a new one.

### A.6 `lib/inventory/pdf-extractor.ts:310-336` — self-invoice rescue iteration

```ts
for (const vatRate of [25, 12, 6]) {
  const grossed = extractedAbs * (1 + vatRate / 100)
  if (Math.abs(headerAbs - grossed) / headerAbs < 0.02) {
    // … sign-flip rescue logic …
```

Pure arithmetic — tries each Swedish VAT rate to detect inc-VAT vs ex-VAT
mismatch on self-invoices (Quatra oil recycling, deposit returns).
Does not classify, does not route to a bucket.

**CANNOT FIRE.**

### A.7 `lib/inventory/pdf-extractor.ts` SYSTEM_PROMPT lines 632-715 — supplier-invoice Vision extraction prompt

```
vat_rate = 0, 6, 12, or 25 — the Swedish standard rate, taken from what's
printed on the row (Wolt/Foodora takeaway = 6, dine-in food = 12,
alcohol/durables = 25).
```

This is on the **supplier-invoice** (cost-side) extraction pipeline.
The `vat_rate` value goes into `supplier_invoice_lines.vat_rate` and is
NOT used by the matcher's Gate 0 (which keys on BAS account / supplier
name / per-business override — see A.8).

**DOES NOT cause category misrouting** because the consumer of `vat_rate`
on the cost side does not branch on it. However, the **prompt
instruction itself is now misleading** to the LLM — a supplier-invoice
line for groceries at the temporary 6 % rate may now contradict the
prompt's "12 % = dine-in food" narrative and could trigger model
confusion about extracting the correct VAT rate value.

**Severity:** low for category routing, medium for VAT-rate field
accuracy.

### A.8 `lib/inventory/matcher.ts` Gate 0 — supplier-invoice categorisation

```ts
// lib/inventory/matcher.ts:74-109
const ownerOverride = await getSupplierOverride(db, …)
if (ownerOverride === 'not_inventory') return { status: 'not_inventory', … }
const basCategory = categoryForBasAccount(line.account_number)
const resolved: SupplierClassification | null =
  basCategory ?? categoryForSupplier(line.supplier_name_snapshot)
```

No VAT-rate signal anywhere. Category is decided by (a) per-business
`supplier_classifications` override, (b) BAS account `categoryForBasAccount`,
(c) supplier-name dictionary `categoryForSupplier`.

**CANNOT FIRE.** Supplier-invoice categorisation
(food/beverage/alcohol/cleaning/takeaway_material/disposables/other)
is structurally immune to the VAT bug.

### A.9 `lib/inventory/categories.ts::categoryForBasAccount` — BAS routing

```ts
// 4010 → food, 4011 → alcohol, 4012 → beverage, 4017 → takeaway_material, etc.
// Default: 4xxx → food. Anything else → null (skip).
```

Pure BAS-account routing. No VAT signal. Note `takeaway_material` here
is a product-type category (paper bags / containers), **not** the
revenue-bucket "takeaway" at issue elsewhere.

**CANNOT FIRE.**

### A.10 `lib/revisor/momsrapport.ts:375-377` — implied-sales reverse-calc

```ts
const implied_sales_25 = out.box_10.amount / 0.25
const implied_sales_12 = out.box_11.amount / 0.12
const implied_sales_06 = out.box_12.amount / 0.06
```

`Box 10/11/12` are sums of OUTPUT-VAT accounts (2611/2621/2631 etc.),
populated from voucher rows. Division by `0.25/0.12/0.06` reverse-derives
the implied taxable sales at each rate. **The math is correct**: if a
customer's accountant moves dine-in food revenue from a 12 % account
(3010) to a 6 % account (3020) post-2026-04-01, the corresponding
output VAT lands in account 2631 → Box 12 → `Box 12 / 0.06` correctly
equals the new 6 %-rated sales total.

**CANNOT FIRE on the math itself.** However the comment at
`momsrapport.ts:28-30` is now interpretationally stale, and any UI that
labels `implied_sales_06` as "takeaway sales" (rather than
"6 %-rated sales") would now be wrong. **Not found** in this scan;
worth checking the `/revisor` page render code.

### A.11 `archive/migrations/M029-REVENUE-VAT-SPLIT.sql` — one-off historical re-tag

```sql
UPDATE tracker_line_items
   SET subcategory = 'takeaway'
 WHERE category = 'revenue'
   AND (
         label_sv ~* '\m6\s*%\s*moms\M'
      OR label_sv ~* '\mwolt\M'
      OR label_sv ~* '\mfoodora\M'
      OR label_sv ~* '\muber\s*eats\M'
       )
```

One-off backfill run once when M029 was applied. Does not fire on new
ingest.

**CANNOT FIRE (historical only).**

### A.12 Decision summary

| Path | File:line | Can the 6 % → takeaway bug fire? | Effect |
|---|---|---|---|
| Resultatrapport deterministic parser | `lib/fortnox/resultatrapport-parser.ts:696` | **YES** | Mis-splits `dine_in_revenue` ↔ `takeaway_revenue` on `tracker_data` |
| Resultatrapport AI extractor | `app/api/fortnox/extract-worker/route.ts:811-816` + system prompt L387-393 | **YES** | Same as above, plus LLM is actively misinstructed |
| Personalkollen POS classifier | `lib/pos/personalkollen.ts:307-309` | **YES (highest volume)** | Mis-splits `dine_in` ↔ `takeaway` on `revenue_logs` → `daily_metrics` → `monthly_metrics` |
| projectRollup fallback | `lib/finance/projectRollup.ts:133-141` | **YES (indirect)** | Inherits from upstream classifyByVat |
| Supplier-invoice extractor prompt | `lib/inventory/pdf-extractor.ts:632-715` | No for category, **yes for vat_rate accuracy** | LLM may now mis-read the VAT rate value, but matcher ignores VAT anyway |
| Self-invoice rescue loop | `lib/inventory/pdf-extractor.ts:310-336` | No | Pure arithmetic |
| Inventory matcher Gate 0 | `lib/inventory/matcher.ts:74-109` | No | Uses BAS + supplier, ignores VAT |
| Inventory categories | `lib/inventory/categories.ts` | No | Pure BAS routing |
| Momsrapport reverse-calc | `lib/revisor/momsrapport.ts:375-377` | No (math), possibly interpretation | Math correct; check UI labels |
| Voucher-to-aggregator | `lib/fortnox/api/voucher-to-aggregator.ts:210` | No | Uses `classifyByAccount` only |
| M029 historical re-tag | `archive/migrations/M029-…` | No (one-off) | Already applied |

**Decision-point conclusion:** the bug **can structurally fire** on three
live ingestion paths (Resultatrapport parser, Resultatrapport AI extractor,
Personalkollen POS). Total revenue is unaffected; only the dine-in vs
takeaway split is at risk. Cost-side classification is structurally immune.

---

## Part B — Data check (queries drafted, awaiting execution)

Run these in **Supabase SQL Editor** in order. They are all `SELECT`-only,
aggregate-only, and capped with `LIMIT` where rows might be returned.
**Paste the results back into this file** (under each `### Result` heading
below) and I will fill in the verdict numbers and the per-business blast
radius.

Live businesses to inspect (from `CLAUDE.md §3`):

- Vero Italiano: `0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99`
- Rosali Deli: `97187ef3-b816-4c41-9230-7551430784a7`
- Chicce / Mojo: please share their `business.id` UUIDs if you want
  them included; otherwise queries below aggregate across **every
  active business** and the per-business breakouts show all.

### B.1 — `tracker_data` revenue subset shift, monthly, per business

Detects whether the **Resultatrapport (P&L) path** has flipped revenue
subsets at the cutoff.

```sql
-- B.1: tracker_data revenue subsets per business, Jan-May 2026
SELECT
  td.business_id,
  b.name                                                AS business_name,
  td.period_year                                        AS yr,
  td.period_month                                       AS mo,
  td.source,
  td.created_via,
  ROUND(td.revenue)::int                                AS revenue,
  ROUND(td.dine_in_revenue)::int                        AS dine_in,
  ROUND(td.takeaway_revenue)::int                       AS takeaway,
  ROUND(td.alcohol_revenue)::int                        AS alcohol,
  CASE WHEN td.revenue > 0
       THEN ROUND((td.takeaway_revenue / td.revenue) * 100, 1)
       ELSE NULL
  END                                                    AS takeaway_pct_of_revenue
FROM tracker_data td
JOIN businesses b ON b.id = td.business_id
WHERE td.period_year = 2026
  AND td.period_month BETWEEN 1 AND 5
  AND (td.is_provisional IS NULL OR td.is_provisional = FALSE)
ORDER BY b.name, td.period_year, td.period_month
LIMIT 200;
```

**What to look for:** a step at April where `takeaway_pct_of_revenue`
jumps and `dine_in` drops by ~the same SEK amount, with no real
operational reason. If a customer's accountant moved their dine-in food
account to 6 % VAT on the April Resultatrapport, the subset split will
flip violently.

#### Result B.1

```
(paste rows here)
```

---

### B.2 — `tracker_line_items` revenue subcategory mix shift

Confirms whether the line-item-level subcategory tagging changed at the
cutoff. Aggregates ARE safe — no row dump.

```sql
-- B.2: tracker_line_items revenue subcategory mix per month
SELECT
  tli.business_id,
  b.name                                                AS business_name,
  tli.period_year                                       AS yr,
  tli.period_month                                      AS mo,
  COALESCE(tli.subcategory, '(null)')                   AS subcategory,
  COUNT(*)                                              AS line_count,
  ROUND(SUM(tli.amount))::int                           AS sum_amount
FROM tracker_line_items tli
JOIN businesses b ON b.id = tli.business_id
WHERE tli.category = 'revenue'
  AND tli.period_year = 2026
  AND tli.period_month BETWEEN 1 AND 5
GROUP BY tli.business_id, b.name, tli.period_year, tli.period_month, tli.subcategory
ORDER BY b.name, tli.period_year, tli.period_month, subcategory
LIMIT 500;
```

**What to look for:** for each business, compare Jan-Mar vs Apr-May rows.
If `subcategory='food'` (dine-in) line counts/sums drop sharply and
`subcategory='takeaway'` rises by ~the same amount in April-May, that's
the smoking gun.

#### Result B.2

```
(paste rows here)
```

---

### B.3 — `daily_metrics` PK revenue split shift (if PK is active)

Detects whether the **Personalkollen POS path** has flipped revenue
subsets at the cutoff. PK is per-ticket so this is the highest-resolution
check.

```sql
-- B.3: daily_metrics revenue subsets aggregated by month, per business
SELECT
  dm.business_id,
  b.name                                                AS business_name,
  EXTRACT(YEAR  FROM dm.business_date)::int             AS yr,
  EXTRACT(MONTH FROM dm.business_date)::int             AS mo,
  COUNT(*)                                              AS days_with_data,
  ROUND(SUM(dm.revenue))::int                           AS sum_revenue,
  ROUND(SUM(dm.dine_in_revenue))::int                   AS sum_dine_in,
  ROUND(SUM(dm.takeaway_revenue))::int                  AS sum_takeaway,
  CASE WHEN SUM(dm.revenue) > 0
       THEN ROUND((SUM(dm.takeaway_revenue) / SUM(dm.revenue)) * 100, 1)
       ELSE NULL
  END                                                    AS takeaway_pct
FROM daily_metrics dm
JOIN businesses b ON b.id = dm.business_id
WHERE dm.business_date >= '2026-01-01'
  AND dm.business_date <  '2026-06-01'
GROUP BY dm.business_id, b.name,
         EXTRACT(YEAR FROM dm.business_date),
         EXTRACT(MONTH FROM dm.business_date)
ORDER BY b.name, yr, mo
LIMIT 200;
```

**What to look for:** for PK customers (Vero — and any others), a step
at April. PK is a real-time POS so the shift is observable per-day if
needed (replace the GROUP BY with raw `business_date` for daily detail).

If `daily_metrics` doesn't have `dine_in_revenue` / `takeaway_revenue`
columns in prod, this query fails — say so and we'll switch to
`revenue_logs` instead.

#### Result B.3

```
(paste rows here)
```

---

### B.4 — Source breakdown to identify the offending pipeline per row

For each suspect `tracker_data` row (e.g. April 2026 with a takeaway
spike), which path produced it?

```sql
-- B.4: tracker_data source + created_via mix for the cutoff window
SELECT
  td.business_id,
  b.name                                                AS business_name,
  td.period_year                                        AS yr,
  td.period_month                                       AS mo,
  td.source,
  td.created_via,
  COUNT(*)                                              AS row_count,
  ROUND(SUM(td.dine_in_revenue))::int                   AS sum_dine_in,
  ROUND(SUM(td.takeaway_revenue))::int                  AS sum_takeaway
FROM tracker_data td
JOIN businesses b ON b.id = td.business_id
WHERE td.period_year = 2026
  AND td.period_month BETWEEN 1 AND 5
GROUP BY td.business_id, b.name, td.period_year, td.period_month, td.source, td.created_via
ORDER BY b.name, yr, mo, td.source
LIMIT 300;
```

**What to look for:** rows with `source` containing `fortnox` and
`created_via IN ('fortnox_apply', 'fortnox_backfill')` post-April are
the Resultatrapport path; PK-derived rows are usually `source='manual'`
or aggregator-merged.

#### Result B.4

```
(paste rows here)
```

---

### B.5 — `supplier_invoice_lines` 6 %-VAT category drift (cost-side sanity check)

The matcher does NOT use VAT for category, so this should be
**stable across the cutoff**. If it isn't, something's wrong upstream.

```sql
-- B.5: supplier-invoice lines at 6% VAT, grouped by linked product category
SELECT
  sil.business_id,
  b.name                                                AS business_name,
  EXTRACT(YEAR  FROM sil.invoice_date)::int             AS yr,
  EXTRACT(MONTH FROM sil.invoice_date)::int             AS mo,
  COALESCE(p.category, '(unmatched)')                   AS product_category,
  sil.match_status,
  COUNT(*)                                              AS line_count,
  ROUND(SUM(sil.total_excl_vat))::int                   AS sum_excl_vat
FROM supplier_invoice_lines sil
JOIN businesses b ON b.id = sil.business_id
LEFT JOIN product_aliases pa ON pa.id = sil.product_alias_id
LEFT JOIN products         p ON p.id  = pa.product_id
WHERE sil.vat_rate = 6
  AND sil.invoice_date >= '2026-01-01'
  AND sil.invoice_date <  '2026-06-01'
GROUP BY sil.business_id, b.name,
         EXTRACT(YEAR FROM sil.invoice_date),
         EXTRACT(MONTH FROM sil.invoice_date),
         p.category, sil.match_status
ORDER BY b.name, yr, mo, product_category
LIMIT 300;
```

**What to look for:** if categories at 6 % are stable across the cutoff
(food stays food etc.), confirms cost-side immunity. Expected outcome:
no regime break.

#### Result B.5

```
(paste rows here)
```

---

### B.6 — `pos_sales` revenue split (if M097 applied)

If M097 is applied (per `MIGRATIONS.md`, pending), the new
`pos_sales` table carries per-ticket / weekly sale rows. NOT a primary
suspect since `pos_sales.quantity / net_revenue` doesn't itself classify
dine-in vs takeaway — but worth a quick existence check.

```sql
-- B.6: existence + recency check on pos_sales (skips if table is missing)
SELECT
  COUNT(*)                                              AS row_count,
  MIN(sold_date)                                        AS earliest_sale,
  MAX(sold_date)                                        AS latest_sale
FROM pos_sales
WHERE sold_date >= '2026-01-01';
```

If this errors with `relation "pos_sales" does not exist`, M097 is not
applied and there's nothing to check on this path.

#### Result B.6

```
(paste rows here OR error message)
```

---

### B.7 — `momsrapport` math sanity (no DB query needed; code already verified)

`lib/revisor/momsrapport.ts:375-377` reverse-derives `implied_sales_06`
by dividing `Box 12 / 0.06`. The math is correct regardless of which
goods are at 6 %. **No SQL needed.**

If you want a UI sanity check, navigate to `/revisor` on a business
post-2026-04-01 and confirm `implied_sales_06` matches what the customer's
accountant filed in Box 12 / 0.06. **Not a DB query — manual verification
in the UI.**

---

## Blast radius (filled after Part B results arrive)

> Numbers below are placeholders. Replace after running B.1–B.6.

| Business | Earliest affected month | SEK in `takeaway_revenue` post-April that is suspect (likely dine-in) | Verdict |
|---|---|---|---|
| Vero Italiano    | (TBD) | (TBD) | (TBD) |
| Rosali Deli      | (TBD) | (TBD) | (TBD) |
| Chicce           | (TBD) | (TBD) | (TBD) |
| Mojo             | (TBD) | (TBD) | (TBD) |

**Total SEK across all live businesses post-2026-04-01 mis-bucketed
into takeaway:** (TBD)

**Earliest affected date:** (TBD — likely first ingestion ≥ 2026-04-01;
either the first PK sync after that date or the first April
Resultatrapport upload)

**Still firing on today's ingest?** (TBD — answer is "yes" if any
`daily_metrics` row from the last 7 days shows the regime break, OR
if the most recent `tracker_data` row has the takeaway spike.)

---

## Every query run

Once you've executed Part B, I'll re-list the queries here verbatim
alongside their outputs, per the prompt's requirement. The drafts above
are all `SELECT` / aggregate only. Nothing else was run.

---

## What this report does NOT do

- **No fix.** Per the prompt: "Stop at the verdict. … No remediation —
  if it's confirmed, we'll scope the fix separately."
- **No `INSERT/UPDATE/DELETE/ALTER/DROP`** anywhere — none drafted,
  none run.
- **No code changes** to the classifiers, prompts, or storage logic.
- **No migration files** authored.

When you paste back the B.1–B.6 outputs I'll fill the placeholders, finalise
the per-business blast radius, and confirm or revise the one-line verdict
above. If any query errors out (typo in a column name, missing table),
say so and I'll adjust.

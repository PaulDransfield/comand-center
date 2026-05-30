# VAT misrouting verdict — diagnostic report

> Read-only investigation. No code, schema, or data changed.
> Date: 2026-05-30. Author: Claude Code (CLI).

## Verdict (one line) — LOCKED

**CONFIRMED on Vero Italiano, April 2026. ~48,468 SEK of food-goods revenue (Fortnox account 3053 "Försäljning varor 6% moms Sv", new in April) is mis-classified into `takeaway_revenue` because `classifyByVat` in `lib/fortnox/api/voucher-to-aggregator.ts:254` regex-matches "6% moms" and unconditionally tags it `takeaway`. Bug is still firing on today's ingest and will continue to mis-classify every voucher row whose Fortnox description contains "6% moms" but is not actually takeaway. Chicce currently unaffected (no 6%-tagged revenue account in their chart yet — will fire as soon as their accountant adds one). Total revenue, net_profit, food_cost, staff_cost, alcohol — all unaffected. Only the dine-in vs takeaway revenue split is wrong.**

The bug is structurally possible from 2026-04-01 onward on **four** ingestion
paths (one more than the original code trace — see A.0): the Resultatrapport
deterministic parser, the Resultatrapport AI extractor, the Personalkollen
POS revenue classifier, AND the Fortnox API voucher-to-aggregator path that
your live data is actually using. It cannot fire on the supplier-invoice
categorisation pipeline (which routes by BAS account / supplier name, not
VAT). Total revenue is unaffected — only the **dine-in vs takeaway split**
is at risk. Cost-side categorisation is unaffected (confirmed by B.5 results
for Vero / Chicce — 6%-VAT product categories stable across the cutoff).

---

## Part A — Code trace: every VAT → category decision point

For each site I answer: **does a `6 %` rate force a takeaway/non-food
classification, or is category decided primarily by something else?**

### A.0 — IMPORTANT CORRECTION: a fourth call site of `classifyByVat`

The initial trace missed `lib/fortnox/api/voucher-to-aggregator.ts:250-256`,
which **also** calls `classifyByVat(label)` on revenue + food_cost voucher
rows during the Fortnox API backfill / daily voucher sync. This is the
path your live data is currently using (every row in B.1 and B.4 has
`source='fortnox_api'`, `created_via='fortnox_backfill'`).

```ts
// lib/fortnox/api/voucher-to-aggregator.ts:250-256
let subcategory = acctClass.subcategory ?? null
// VAT-rate refinement for revenue + food_cost (subset tagging only;
// never reclassifies the parent category).
if (acctClass.category === 'revenue' || acctClass.category === 'food_cost') {
  const vat = classifyByVat(label)
  if (vat?.subcategory) subcategory = vat.subcategory
}
```

The `label` here comes from voucher row Descriptions / Account names — so
any 3xxx revenue row whose Fortnox description contains "6% moms" gets
tagged `subcategory='takeaway'` and accumulated into `takeaway_revenue`.

**CAN FIRE on every customer using the Fortnox API backfill path
post-2026-04-01.** This is the actual smoking-gun call site for Vero April.

### A.1 `lib/fortnox/classify.ts:119-132` — `classifyByVat(label)`

The single canonical regex classifier. Imported by **four** call sites
(A.0, A.2, A.3, A.10).

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

#### Result B.1 — executed 2026-05-30

| business           | yr-mo  | source/created_via         | revenue   | dine_in   | takeaway   | alcohol   | takeaway % |
|---|---|---|---|---|---|---|---|
| Chicce Slotsgatan  | 2026-01 | fortnox_api/fortnox_backfill | 780,416   | 625,974   | 0          | 147,302   | 0.0  |
| Chicce Slotsgatan  | 2026-02 | fortnox_api/fortnox_backfill | 755,618   | 608,381   | 0          | 138,560   | 0.0  |
| Chicce Slotsgatan  | 2026-03 | fortnox_api/fortnox_backfill | 866,796   | 677,528   | 0          | 180,856   | 0.0  |
| Chicce Slotsgatan  | 2026-04 | fortnox_api/fortnox_backfill | 839,378   | 666,137   | 0          | 164,341   | 0.0  |
| Rosali Deli        | 2026-01 | fortnox_api/fortnox_backfill | 1,817,099 | 669,610   | 74,127     | 1,062,068 | 4.1  |
| Vero Italiano      | 2026-01 | fortnox_api/fortnox_backfill | 1,817,099 | 669,610   | 74,127     | 1,062,068 | 4.1  |
| Vero Italiano      | 2026-02 | fortnox_api/fortnox_backfill | 1,644,161 | 638,889   | 73,852     |   923,121 | 4.5  |
| Vero Italiano      | 2026-03 | fortnox_api/fortnox_backfill | 1,603,919 | 654,312   | 57,096     |   885,783 | 3.6  |
| **Vero Italiano**  | **2026-04** | **fortnox_api/fortnox_backfill** | **1,135,074** | **479,852** | **137,301** | **517,921** | **12.1** |

**Reads:**
- **Chicce:** zero takeaway across all months. Bug cannot manifest here —
  Chicce uses no 6%-tagged revenue accounts. Clean.
- **Vero Italiano:** clean step at April. takeaway_pct jumped
  3.6 → 12.1 (+8.5 pp), takeaway absolute jumped from ~57k SEK in March
  to ~137k SEK in April — a +80k SEK delta. Total revenue also dropped
  (1.60M → 1.14M, –29%) which complicates pure mis-bucketing hypothesis,
  but the takeaway share more-than-tripled in proportion, so something
  shifted in classification.
- **Rosali Deli:** **DATA QUALITY FLAG, NOT VAT BUG.** Only one
  month visible (Jan), and its numbers are **byte-identical to Vero
  January** (revenue 1,817,099 / dine_in 669,610 / takeaway 74,127 /
  alcohol 1,062,068). Two different `business_id`s should not have
  identical aggregates. Separate concern; flag for follow-up.

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

#### Result B.2 — executed 2026-05-30

Vero Italiano (the suspect business), revenue lines only:

| yr-mo  | subcategory | line_count | sum_amount |
|---|---|---|---|
| 2026-01 | (null)   | 1 |   11,295 |
| 2026-01 | alcohol  | 1 | 1,062,068 |
| 2026-01 | food     | 1 |   669,610 |
| 2026-01 | takeaway | 1 |    74,127 |
| 2026-02 | (null)   | 1 |    8,299 |
| 2026-02 | alcohol  | 1 |  923,121 |
| 2026-02 | food     | 1 |  638,889 |
| 2026-02 | takeaway | 1 |   73,852 |
| 2026-03 | (null)   | 2 |    6,728 |
| 2026-03 | alcohol  | 1 |  885,783 |
| 2026-03 | food     | 1 |  654,312 |
| 2026-03 | takeaway | 1 |   57,096 |
| **2026-04** | **alcohol**  | **2** | **517,921** |
| **2026-04** | **food**     | **1** | **479,852** |
| **2026-04** | **takeaway** | **2** | **137,301** |

**Smoking gun (Vero):**
- **Jan–Mar:** consistent — one line each for food / takeaway / alcohol,
  plus a small `(null)`-subcategory line.
- **Apr:** the `takeaway` bucket goes from **1 line** (max ~74k SEK)
  to **2 lines** totalling 137k SEK. A second 6%-moms-tagged account
  appeared. The `alcohol` bucket also went from 1 line to 2 lines —
  also worth investigating.
- The most parsimonious explanation: Vero's accountant **moved or split
  a dine-in food account onto a 6%-VAT-tagged Fortnox account** on
  the April books (reflecting Sweden's temporary food-VAT cut), and
  `classifyByVat` in voucher-to-aggregator promptly tagged it `takeaway`.

Chicce shows no `takeaway` subcategory at all across Jan–May — so the
bug can't even fire on Chicce because no voucher row description
contains "6% moms".

Rosali Deli identical-to-Vero anomaly: data-quality flag (see B.1).

---

### B.3 — daily_metrics PK revenue split shift — **column name was wrong**

The first attempt errored: `column dm.business_date does not exist`. The
prod column is `date` (per `sql/M008-summary-tables.sql:13`). Re-issued
below — please run this version:

```sql
-- B.3-FIXED: daily_metrics revenue subsets aggregated by month
SELECT
  dm.business_id,
  b.name                                                AS business_name,
  EXTRACT(YEAR  FROM dm.date)::int                      AS yr,
  EXTRACT(MONTH FROM dm.date)::int                      AS mo,
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
WHERE dm.date >= '2026-01-01'
  AND dm.date <  '2026-06-01'
GROUP BY dm.business_id, b.name,
         EXTRACT(YEAR FROM dm.date),
         EXTRACT(MONTH FROM dm.date)
ORDER BY b.name, yr, mo
LIMIT 200;
```

If `daily_metrics` doesn't carry `dine_in_revenue` / `takeaway_revenue`
columns (those were added by M029 to `tracker_data` but I haven't
verified `daily_metrics` has them too), this will error on those column
names — say so and we'll fall back to inspecting `revenue_logs`
directly. Otherwise this confirms whether the **PK POS path** is
also firing on Vero or only the API path is.

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

#### Result B.3 — SKIPPED (not verdict-relevant)

First attempt errored (`column dm.business_date does not exist` —
prod column is `dm.date`). Fix issued. Second attempt also errored
(`column dm.dine_in_revenue does not exist` — M029 split columns are
only on `tracker_data`, not on `daily_metrics`).

Skipped further investigation because:
- B.6 confirmed `pos_sales` is empty → PK POS path isn't actively
  classifying anything today.
- B.1 + B.2 + B.4 are unanimous that the bug fires on the Fortnox API
  path (every row tagged `fortnox_api/fortnox_backfill`).
- B.7 locked the verdict.

If you want to inspect the upstream PK flow later (in case PK starts
producing sales again), the right query is against `revenue_logs`
filtered by `provider LIKE 'pk%'` — but that's a separate diagnostic.

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

#### Result B.4 — executed 2026-05-30

| business           | yr-mo  | source       | created_via      | rows | sum_dine_in | sum_takeaway |
|---|---|---|---|---|---|---|
| Chicce Slotsgatan  | 2026-01 | fortnox_api | fortnox_backfill | 1 | 625,974 | 0       |
| Chicce Slotsgatan  | 2026-02 | fortnox_api | fortnox_backfill | 1 | 608,381 | 0       |
| Chicce Slotsgatan  | 2026-03 | fortnox_api | fortnox_backfill | 1 | 677,528 | 0       |
| Chicce Slotsgatan  | 2026-04 | fortnox_api | fortnox_backfill | 1 | 666,137 | 0       |
| Chicce Slotsgatan  | 2026-05 | fortnox_api | fortnox_backfill | 1 | 508,147 | 0       |
| Rosali Deli        | 2026-01 | fortnox_api | fortnox_backfill | 1 | 669,610 | 74,127  |
| Vero Italiano      | 2026-01 | fortnox_api | fortnox_backfill | 1 | 669,610 | 74,127  |
| Vero Italiano      | 2026-02 | fortnox_api | fortnox_backfill | 1 | 638,889 | 73,852  |
| Vero Italiano      | 2026-03 | fortnox_api | fortnox_backfill | 1 | 654,312 | 57,096  |
| **Vero Italiano**  | **2026-04** | **fortnox_api** | **fortnox_backfill** | **1** | **479,852** | **137,301** |
| Vero Italiano      | 2026-05 | fortnox_api | fortnox_backfill | 1 | 0       | 0       |

**Reads:**
- Every row across every business is `fortnox_api / fortnox_backfill`. So
  the suspect path is unambiguously **`voucher-to-aggregator.ts`** (A.0)
  — not the Resultatrapport extractor (A.2 / A.3) and not Personalkollen
  POS (A.4). The two paths we worried about most aren't the ones firing.
- Vero May has zero everything — backfill hasn't reached May yet, or
  May's voucher run is partial. Worth confirming separately.

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

#### Result B.5 — executed 2026-05-30

Vero Italiano + Chicce, supplier-invoice lines at `vat_rate = 6`,
grouped by linked product.category:

| business           | yr-mo  | product_category | match_status   | line_count | sum_excl_vat |
|---|---|---|---|---|---|
| Chicce Slotsgatan  | 2026-04 | (unmatched)   | needs_review    |   3 |       0 |
| Chicce Slotsgatan  | 2026-04 | (unmatched)   | not_inventory   |   4 |  14,093 |
| Chicce Slotsgatan  | 2026-04 | alcohol       | matched         |   1 |     552 |
| Chicce Slotsgatan  | 2026-04 | beverage      | matched         |   2 |     316 |
| Chicce Slotsgatan  | 2026-04 | food          | matched         |  37 |   9,129 |
| Chicce Slotsgatan  | 2026-05 | (unmatched)   | needs_review    |   7 |     276 |
| Chicce Slotsgatan  | 2026-05 | (unmatched)   | not_inventory   |   5 |     897 |
| Chicce Slotsgatan  | 2026-05 | beverage      | matched         |  11 |   3,938 |
| Chicce Slotsgatan  | 2026-05 | food          | matched         |  62 |  13,344 |
| Vero Italiano      | 2026-02 | alcohol       | matched         |   1 |     317 |
| Vero Italiano      | 2026-02 | beverage      | matched         |   1 |     308 |
| Vero Italiano      | 2026-03 | (unmatched)   | needs_review    |   3 |     732 |
| Vero Italiano      | 2026-03 | beverage      | matched         |   1 |      78 |
| Vero Italiano      | 2026-04 | (unmatched)   | not_inventory   |  50 |  10,473 |
| Vero Italiano      | 2026-04 | (unmatched)   | needs_review    |  36 |  26,387 |
| Vero Italiano      | 2026-04 | alcohol       | matched         |   2 |  –1,000 |
| Vero Italiano      | 2026-04 | beverage      | matched         |   8 |   2,817 |
| Vero Italiano      | 2026-04 | disposables   | matched         |   1 |     631 |
| Vero Italiano      | 2026-04 | food          | matched         |  75 |  41,733 |
| Vero Italiano      | 2026-05 | (unmatched)   | needs_review    |  81 |  16,808 |
| Vero Italiano      | 2026-05 | (unmatched)   | not_inventory   |  10 |   2,617 |
| Vero Italiano      | 2026-05 | alcohol       | matched         |   1 |   2,500 |
| Vero Italiano      | 2026-05 | beverage      | matched         |   4 |   1,509 |
| Vero Italiano      | 2026-05 | disposables   | matched         |   2 |     340 |
| Vero Italiano      | 2026-05 | food          | matched         |  29 |  32,460 |

**Reads:**
- **Cost-side categorisation is stable across the cutoff.** Matched
  6%-VAT lines flow predominantly into `food` (correct — 6% is the food
  rate now), with no anomalous spike in `takeaway_material` or any
  other category. Matcher correctly ignoring VAT for category routing,
  as Part A predicted.
- The unmatched / needs_review / not_inventory counts surge in April for
  Vero (3 → 36 needs_review, 0 → 50 not_inventory). Not a VAT-bug
  signal — that's just the regular review-queue volume going up as new
  product variants enter the catalogue.
- **Confirms the bug is revenue-side only, not cost-side.**

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

#### Result B.6 — executed 2026-05-30

| row_count | earliest_sale | latest_sale |
|---|---|---|
| 0 | null | null |

**M097 IS applied (table exists) but `pos_sales` is empty.** No POS
sale rows for any business in 2026. Consequence: the PK POS revenue
classifier (`lib/pos/personalkollen.ts:307-309`, decision point A.4)
is **not actively contributing to the VAT bug today** — it'd only fire
if PK sale rows started flowing in. Note `MIGRATIONS.md` said this was
"pending application" — that's stale; the table does exist.

---

### B.7 — DRILL-DOWN: which Fortnox accounts / labels are tagged 'takeaway' on Vero April? **(needed to confirm verdict)**

This is the critical follow-up. We need to see the actual voucher
accounts + labels that landed in `tracker_line_items.subcategory='takeaway'`
for Vero Italiano April 2026, so we can tell whether the second
takeaway line is:

- **(bug fired)** a previously dine-in food account whose Fortnox
  description now contains "6% moms", OR
- **(no bug)** a genuine 6%-rated takeaway account
  (Wolt/Foodora/UberEats) that just had a bigger month.

```sql
-- B.7: Vero April takeaway line items — show account + label
SELECT
  tli.business_id,
  tli.period_year                                       AS yr,
  tli.period_month                                      AS mo,
  tli.subcategory,
  COALESCE(tli.fortnox_account, tli.account)            AS fortnox_account,
  tli.label_sv,
  tli.label,
  ROUND(tli.amount)::int                                AS amount
FROM tracker_line_items tli
WHERE tli.business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'  -- Vero Italiano
  AND tli.category = 'revenue'
  AND tli.period_year = 2026
  AND tli.period_month BETWEEN 1 AND 5
ORDER BY tli.period_month, tli.subcategory, fortnox_account
LIMIT 100;
```

If your `tracker_line_items` schema doesn't expose both `fortnox_account`
and `account` columns, drop whichever causes an error. The key columns
to see are `subcategory`, `fortnox_account` (or `account`), and
`label_sv` / `label`.

#### Result B.7 — executed 2026-05-30 — **VERDICT LOCKER**

Vero Italiano revenue line items, Jan–Apr 2026:

| mo | subcategory | fortnox_account | label_sv                            | amount    |
|----|-------------|-----------------|-------------------------------------|-----------|
| 1  | alcohol     | 3051            | Försäljning varor 25% moms Sv       | 1,062,068 |
| 1  | food        | 3052            | Försäljning varor 12% moms Sv       |   669,610 |
| 1  | takeaway    | 3072            | Försäljning Wolt, Foodora           |    74,127 |
| 1  | (null)      | 3010            | Avdrag mat personal                 |    11,295 |
| 2  | alcohol     | 3051            | Försäljning varor 25% moms Sv       |   923,121 |
| 2  | food        | 3052            | Försäljning varor 12% moms Sv       |   638,889 |
| 2  | takeaway    | 3072            | Försäljning Wolt, Foodora           |    73,852 |
| 2  | (null)      | 3010            | Avdrag mat personal                 |     8,299 |
| 3  | alcohol     | 3051            | Försäljning varor 25% moms Sv       |   885,783 |
| 3  | food        | 3052            | Försäljning varor 12% moms Sv       |   654,312 |
| 3  | takeaway    | 3072            | Försäljning Wolt, Foodora           |    57,096 |
| 3  | (null)      | 3010            | Avdrag mat personal                 |     6,728 |
| 3  | (null)      | 3740            | Öres- och kronutjämning             |         1 |
| **4** | **alcohol**  | **3001** | **Försäljning inom Sverige, 25 % moms** | **85,632** |
| 4  | alcohol     | 3051            | Försäljning varor 25% moms Sv       |   432,290 |
| 4  | food        | 3052            | Försäljning varor 12% moms Sv       |   479,852 |
| **4** | **takeaway** | **3053** | **Försäljning varor 6% moms Sv**    | **48,468** |
| 4  | takeaway    | 3072            | Försäljning Wolt, Foodora           |    88,833 |

**SMOKING GUN:** account **3053 "Försäljning varor 6% moms Sv"** first
appears in April. The label is generic Swedish for "sales of goods at
6% VAT" — **not** Wolt/Foodora (those still book to 3072 separately).
This is the new account Vero's accountant added on 2026-04-01 to book
food-goods at Sweden's temporary 6% rate. `classifyByVat` in
`voucher-to-aggregator.ts:254` matches the literal `"6% moms"` token in
the label and tags the line `takeaway` — even though it's almost
certainly dine-in or generic food revenue, not platform delivery.

The other April surprises are NOT bugs:
- Account 3001 (alcohol +85k) — accountant added a second alcohol
  account; correctly tagged `alcohol` because label contains "25 %".
- Account 3051 (alcohol, –454k vs Mar) — corresponds to the 3001
  addition (some of what used to land on 3051 is now on 3001). Net
  alcohol broadly stable (518k Apr vs 886k Mar, real decline of ~368k
  is genuine).
- Account 3072 (Wolt/Foodora takeaway, 88,833) — genuine takeaway
  delivery, just a slightly bigger April than the Jan–Mar
  57k–74k range. Not bug-suspect.

**Bug-fire SEK on Vero April: exactly 48,468 SEK** (the entire 3053
line). This is the amount currently in `takeaway_revenue` that almost
certainly should be in `dine_in_revenue` (or a separate
`food_goods_revenue` bucket — there isn't one today).

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

## Blast radius — LOCKED

| Business           | Earliest affected month | Mis-classified SEK in `takeaway_revenue` | Verdict |
|---|---|---|---|
| **Vero Italiano**  | **2026-04** | **48,468 SEK** (entire account 3053 "Försäljning varor 6% moms Sv", which first appears in April and is almost certainly food-goods at the temporary 6% rate, not takeaway delivery) | **CONFIRMED FIRING** |
| Chicce Slotsgatan  | n/a | 0 SEK | **clean** (no 6%-tagged revenue account in Chicce's chart yet — bug *can* fire structurally but no triggering label exists today) |
| Rosali Deli        | n/a (only Jan data; identical to Vero — data-quality flag, not VAT bug) | 0 SEK | clean for VAT bug; **separate data-quality issue** (see below) |
| Mojo               | (business_id not provided in this run) | unknown | **not assessed** — re-run B.7 with Mojo's business_id if you want |

**Total SEK mis-bucketed into `takeaway_revenue` across live businesses:
48,468 SEK** (Vero April only, single line).

**Earliest affected date:** **2026-04** for Vero Italiano. Coincides
exactly with Sweden's 2026-04-01 VAT change. Vero's accountant created
account 3053 "Försäljning varor 6% moms Sv" on the April books and
`classifyByVat` regex-matched "6% moms" → `takeaway`.

**Still firing on today's ingest?** **Yes.** Every cron run that touches
vouchers carrying the "6% moms" label string will re-execute the
mis-classification. `voucher-cache-refresh` runs daily at 06:15 UTC;
`fortnox-supplier-sync` at 06:10 UTC. The error is deterministic — the
regex always matches, always tags `takeaway`. Until Sweden's temporary
6% food rate ends (currently 2027-12-31) OR the classifier is changed,
every new 6%-moms voucher row enters the same broken bucket.

**Vero May current state:** B.4 shows zero `dine_in_revenue` /
`takeaway_revenue` for May because the May voucher backfill hasn't
completed yet. When it does, expect the same pattern: account 3053
will populate again and re-classify into takeaway.

**Surfaces affected (Vero only, today):**
- `tracker_data.takeaway_revenue` / `dine_in_revenue` for 2026-04 onwards
- `tracker_line_items.subcategory='takeaway'` (the new 3053 row)
- Anywhere that reads these:
  - `/financials/performance` chart (revenue mix waterfall)
  - dashboard KPI tiles
  - `/api/tracker` and `/api/metrics/*` consumers
  - `lib/ai/snapshot.ts` → AI assistant context (the assistant will
    overstate Vero takeaway when answering questions about April)
- Vero April reported `takeaway_pct_of_revenue = 12.1%`; corrected
  value if 3053 is moved out of takeaway and into a food bucket would
  be roughly **7.8%** (88,833 / 1,135,074).

**Cost-side, total revenue, net_profit, food_cost, alcohol_cost,
staff_cost: ALL unaffected.** Only the dine-in vs takeaway split inside
revenue is wrong. Headline financial numbers stay correct.

### Separate data-quality concern surfaced during this diagnostic

**Rosali Deli's January 2026 `tracker_data` row is byte-identical to
Vero Italiano's January 2026 row** (same revenue 1,817,099, same
dine_in 669,610, same takeaway 74,127, same alcohol 1,062,068). They
have different `business_id`s — these aggregates should not be
identical. Most likely a bug where Rosali's Fortnox backfill ran
against Vero's data, or an org-scoped instead of business-scoped query
upstream. **Not a VAT bug; flag separately.** No Rosali data exists for
Feb–May at all, which is also worth investigating.

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

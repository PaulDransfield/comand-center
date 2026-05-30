# VAT Misrouting — Fix Plan

> Source diagnostic: `docs/investigation/vat-misrouting-verdict.md`
> Status: SCOPE / RFC. Awaiting owner decisions before implementation.
> Live blast radius today: 48,468 SEK mis-classified in Vero April 2026.
> Bug continues to fire on every daily voucher sync.

## 1. Problem (one paragraph)

`lib/fortnox/classify.ts:121-124::classifyByVat` matches the literal
string `"6% moms"` in any voucher / P&L line label and returns
`subcategory='takeaway'`. Before Sweden's 2026-04-01 temporary food-VAT
cut, that was correct (6 % VAT was only used for takeaway/Wolt/Foodora
food sales). After 2026-04-01, foodstuffs sold as **goods** are also 6 %,
so the same regex is now firing on revenue rows that are not takeaway.
Confirmed on Vero Italiano: a new Fortnox revenue account 3053
"Försäljning varor 6% moms Sv" appeared in April with 48,468 SEK and is
sitting in `tracker_data.takeaway_revenue` instead of `dine_in_revenue`.
The classifier is called from **four** sites (voucher-to-aggregator,
Resultatrapport parser, Resultatrapport AI extractor, projectRollup
fallback) — only the first is firing today on Vero's data, but the
others would fire as soon as a Resultatrapport PDF with a 6 % food line
is uploaded.

## 2. Goals & non-goals

**Goals**

- Stop the bug from firing on new ingest within 24 hours of merge.
- Correct already-mis-classified Vero April rows (and any other
  affected business — currently just Vero).
- Make the rule durable through 2027-12-31 (end of Sweden's temporary
  cut) and resilient to its eventual reversion.
- Centralise Swedish VAT rate constants so the next regulatory change
  doesn't require hunting through seven files (see verdict §8.2).

**Non-goals (this plan, deliberate scope cuts)**

- Solving the `daily_metrics` / `tracker_data` schema asymmetry (M029
  added split columns only to `tracker_data`). Out of scope; flag for
  a separate plan if/when PK POS data starts flowing again.
- Solving the Rosali Deli == Vero Italiano data-duplication anomaly
  surfaced in B.1. Out of scope; separate diagnostic needed.
- Building an admin UI for per-business account → subset override
  mappings. Phase 3 (if at all).
- Rewriting the AI assistant snapshot to expose "food goods" as a
  separate KPI tile. Phase 3 (UI work).

## 3. Owner decisions needed BEFORE implementation

Before any code is written, three calls need to be made. None are
technically forced — they're judgement calls about how restaurant
finance should be presented.

### 3.1 Where does the new 6 % food revenue belong?

Today's `tracker_data` schema (post-M029):
- `revenue` — total
- `dine_in_revenue` — historically 12 % moms food
- `takeaway_revenue` — historically 6 % moms food (Wolt/Foodora etc.)
- `alcohol_revenue` — 25 % moms

Sweden's 6 % food rate from 2026-04-01 covers BOTH takeaway food AND
food sold as goods (groceries, packaged items, take-home portions).
Where should the 6 %-rated food-goods revenue go?

**Option α — Lump it into `dine_in_revenue` by default.** Reasonable
for restaurants whose 6 %-account is "leftover meal" or "frozen dish
to take home from the restaurant counter" — adjacent to dine-in for
margin analysis. Wrong for restaurants where 6 % truly is platform
delivery only.

**Option β — Lump it into `takeaway_revenue` by default.** Keeps
current behaviour. Wrong for the restaurants we know about today
(Vero's 3053 is almost certainly not takeaway).

**Option γ — Leave the subset NULL by default; force per-business
opt-in to either bucket.** Safest. Cost: until the owner configures,
the 6 %-rated revenue is in `revenue` but not in either subset →
`dine_in + takeaway + alcohol < revenue`. The dashboard waterfall
already handles this gracefully (a "(unclassified)" slice exists
because there's already a `(null)` subcategory pattern in the data —
B.7 shows the personnel-meal-deduction rows on account 3010 land
that way).

**Option δ — Add a fourth revenue subset column
`food_goods_revenue`.** Schema migration. Semantically cleanest but
biggest change (UI tiles, AI snapshot, charts, every reader).

**Recommendation:** **Option γ for Phase 1** (safe default — no
mis-bucketing, no schema change). **Option δ for Phase 3** if
2+ customers ask for the split to be visible. **Never Option α or β** —
both make assumptions that will be wrong for some customer.

### 3.2 Backfill scope

The bug fired exclusively on Vero April so far. Two backfill options:

- **Minimal:** re-run `voucher-to-aggregator` for Vero April only,
  with the fixed classifier. Update `tracker_data` Apr row and
  `tracker_line_items` rows for that period.
- **Comprehensive:** re-run for every business × every month ≥ 2026-04-01.
  Safer (catches anything I missed), slower (rate-limit budget on the
  Fortnox API), bigger surface area for "we changed your reported
  numbers".

**Recommendation:** **Minimal** for the in-flight fix; document that
new periods will be re-classified going forward, and surface a one-time
admin button at `/admin/v2/tools` to re-run any (business, period) on
demand if Chicce/Mojo turn up affected later.

### 3.3 AI snapshot + assistant

`lib/ai/snapshot.ts` consumes `dine_in_revenue` / `takeaway_revenue`
and exposes them to every AI surface. After backfill, Vero April's
takeaway % share changes from 12.1 % → 7.8 %. The AI assistant has been
answering questions about Vero April for ~2 months with the wrong split.

- Do nothing — assistant just starts answering correctly tomorrow.
- Add a one-shot note to the snapshot ("Vero April 2026 revenue split
  was reclassified on YYYY-MM-DD; prior conversations may have used a
  different split") for, say, 30 days then drop it.

**Recommendation:** do nothing. Cleanest. The AI has no persistent
memory; new conversations get the correct number from the next snapshot.

---

## 4. Approach (phased)

### Phase 1 — Stop the bleeding (target: this week)

Smallest possible change that prevents new mis-classification, plus
correction of Vero's existing data.

**Code changes**

1. **`lib/sweden/vat.ts` — NEW file.** Single source of truth for
   Swedish VAT constants. Replace the magic numbers scattered across
   `lib/fortnox/classify.ts`, `lib/pos/personalkollen.ts`,
   `lib/revisor/momsrapport.ts`, `lib/inventory/pdf-extractor.ts`,
   `app/api/fortnox/extract-worker/route.ts` system prompt text.
   ```ts
   export const SWEDEN_VAT = {
     STANDARD:        25,   // alcohol, non-food drinks, durables
     RESTAURANT_DINE: 12,   // dine-in restaurant service (unchanged)
     FOOD_GOODS:       6,   // takeaway food + food sold as goods
                            // (temp cut 2026-04-01 → 2027-12-31; was 12 pre-cut)
     ZERO:             0,
   } as const
   export const VALID_VAT_RATES = [0, 6, 12, 25] as const
   // Date the temporary food cut started; null after it ends.
   export const TEMP_FOOD_CUT_START = '2026-04-01'
   export const TEMP_FOOD_CUT_END   = '2027-12-31'
   ```

2. **`lib/fortnox/classify.ts:119-132` — change `classifyByVat`.**
   Remove the `'\b6\s*%?\s*moms\b' → takeaway` rule. Keep ONLY the
   explicit-platform fallback (Wolt / Foodora / UberEats names → takeaway).
   Result: 6 %-moms revenue lines that aren't named after a delivery
   platform default to NULL subcategory (Option γ from §3.1).
   ```ts
   // BEFORE (buggy after 2026-04-01):
   if (/\b6\s*%?\s*moms\b/.test(key))   return { subcategory: 'takeaway' }
   if (/\b(wolt|foodora|uber\s*eats)\b/.test(key)) return { subcategory: 'takeaway' }
   // AFTER:
   if (/\b(wolt|foodora|uber\s*eats)\b/.test(key)) return { subcategory: 'takeaway' }
   // 6%-moms is no longer unambiguously takeaway after 2026-04-01;
   // fall through to null and let downstream classifiers decide.
   ```

3. **`app/api/fortnox/extract-worker/route.ts` system prompt
   lines 387-393** — rewrite the AI prompt to remove the misleading
   "6% moms → takeaway food" instruction. Replace with:
   > "From 2026-04-01 Swedish food VAT is 6% for goods AND for takeaway,
   > and 12% for dine-in restaurant service. Revenue rows tagged
   > 6% moms are AMBIGUOUS — only tag a 6%-moms line as `takeaway` if
   > the label explicitly names Wolt, Foodora, or UberEats. Otherwise
   > leave `subcategory` null and let the operator review."

4. **`lib/inventory/pdf-extractor.ts:632-715` SYSTEM_PROMPT.** Same
   instruction change for the supplier-invoice extractor prompt — it
   currently tells Claude "Wolt/Foodora takeaway = 6, dine-in food = 12".
   That's now misleading. Rewrite to the post-2026-04-01 reality. (Note
   this prompt's vat_rate value isn't used for category routing in the
   matcher, so the impact is on extraction accuracy of the VAT value
   itself, not category — but worth fixing in the same PR to prevent
   downstream confusion.)

5. **`lib/pos/personalkollen.ts:307-309` POS classifier.** Same change
   pattern: drop the `6 % → takeaway` hardcode. For PK sales with 6 %
   VAT items, use PK's own `is_take_away` flag (which the current code
   deliberately ignores in favour of the VAT signal — line 321-323
   comment). Post-fix, the order flips: PK's own flag wins, VAT becomes
   a fallback.

   ```ts
   // BEFORE (treats VAT as authoritative):
   if      (Math.abs(vat - 0.12) < 0.001) { foodNet  += line; dineInNet   += line }
   else if (Math.abs(vat - 0.06) < 0.001) { foodNet  += line; takeawayNet += line }
   // AFTER (food VAT just identifies food vs drink; takeaway comes from PK flag):
   const isFoodVat = Math.abs(vat - 0.12) < 0.001 || Math.abs(vat - 0.06) < 0.001
   const isAlcoholVat = Math.abs(vat - 0.25) < 0.001
   if (isFoodVat)         { foodNet += line; (isTakeawayHint ? takeawayNet : dineInNet) += line }
   else if (isAlcoholVat) { drinkNet += line; dineInNet += line }
   ```

   Where `isTakeawayHint` is `s.is_take_away === true` (PK's own flag).

6. **`lib/fortnox/api/voucher-to-aggregator.ts:250-256`** — no code
   change needed beyond (2): this site calls `classifyByVat` so the
   regex fix propagates.

7. **`lib/finance/projectRollup.ts:133-141`** — same: inherits via
   subcategory column.

8. **`lib/fortnox/resultatrapport-parser.ts:696`** — same: inherits.

**Tests (new — currently no test coverage on the classifier)**

`tests/lib/fortnox/classify.test.ts`:
- Pre-cutoff 6% moms label → subcategory null (was 'takeaway')
- Post-cutoff 6% moms label → subcategory null
- Wolt label → 'takeaway'
- Foodora label → 'takeaway'
- "UberEats" label → 'takeaway'
- 12% moms → 'food'
- 25% moms → 'alcohol'
- Empty / null label → null

`tests/lib/fortnox/voucher-to-aggregator.test.ts`:
- Voucher row with label "Försäljning varor 6% moms Sv" → lineItem
  subcategory null (was 'takeaway')
- Same with "Försäljning Wolt, Foodora" → subcategory 'takeaway'

`tests/lib/pos/personalkollen.test.ts`:
- 6%-VAT line with `is_take_away=false` → dineIn
- 6%-VAT line with `is_take_away=true` → takeaway
- 12%-VAT line → dineIn (regardless of `is_take_away`)
- 25%-VAT line → dineIn (alcohol)

**Database changes**

NONE. Phase 1 is code-only. Schema stays as it is. New 6 %-moms revenue
will accumulate into `revenue` but not into any subset column — both
`tracker_data.dine_in_revenue + takeaway_revenue + alcohol_revenue` and
`tracker_line_items` rollups will show an "unclassified" residual.

**Backfill (post-merge, manual)**

Single Supabase SQL run for Vero April:

```sql
-- Phase 1 backfill: move Vero account 3053 out of takeaway
-- Run AFTER Phase 1 code is deployed. Idempotent.
BEGIN;

-- 1. Re-tag the line item subcategory to NULL
UPDATE tracker_line_items
   SET subcategory = NULL
 WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year = 2026
   AND period_month = 4
   AND category = 'revenue'
   AND fortnox_account = 3053
   AND subcategory = 'takeaway';

-- 2. Re-derive tracker_data.takeaway_revenue from the corrected line items
UPDATE tracker_data td
   SET takeaway_revenue = (
     SELECT COALESCE(SUM(tli.amount), 0)
       FROM tracker_line_items tli
      WHERE tli.business_id = td.business_id
        AND tli.period_year = td.period_year
        AND tli.period_month = td.period_month
        AND tli.category = 'revenue'
        AND tli.subcategory = 'takeaway'
   )
 WHERE td.business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND td.period_year = 2026
   AND td.period_month = 4;

-- 3. Sanity check — should now show Vero April takeaway = 88,833 (only Wolt)
SELECT business_id, period_year, period_month,
       revenue, dine_in_revenue, takeaway_revenue, alcohol_revenue
  FROM tracker_data
 WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year = 2026
   AND period_month = 4;

COMMIT;
```

If the sanity check shows takeaway_revenue = 88,833 (just the Wolt
account 3072 amount), commit. If anything else, ROLLBACK and re-investigate.

**Files touched (Phase 1)**

- `lib/sweden/vat.ts` (new, ~20 lines)
- `lib/fortnox/classify.ts` (5-line change)
- `lib/pos/personalkollen.ts` (10-line change)
- `app/api/fortnox/extract-worker/route.ts` (prompt text edit, ~15 lines)
- `lib/inventory/pdf-extractor.ts` (prompt text edit, ~10 lines)
- `tests/lib/fortnox/classify.test.ts` (new, ~40 lines)
- `tests/lib/fortnox/voucher-to-aggregator.test.ts` (new, ~30 lines)
- `tests/lib/pos/personalkollen.test.ts` (new or extend, ~40 lines)

Total: ~150 LOC + one ~20-line backfill SQL. ~1 day of focused work.

### Phase 2 — Per-business account override (target: next 1-2 weeks)

After Phase 1, 6 %-moms revenue lands in `revenue` but not in any
subset. That's safe but loses information. Phase 2 lets each business
opt-in to mapping specific Fortnox accounts to specific subsets.

**Schema**

```sql
-- M105-REVENUE-ACCOUNT-MAPPING.sql
CREATE TABLE IF NOT EXISTS public.revenue_account_mapping (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  fortnox_account INTEGER NOT NULL,
  subset          TEXT NOT NULL CHECK (subset IN
                    ('dine_in', 'takeaway', 'alcohol', 'food_goods', 'other')),
  configured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  configured_by   UUID,  -- auth.users.id
  notes           TEXT,
  UNIQUE (business_id, fortnox_account)
);
ALTER TABLE public.revenue_account_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY rev_acct_map_org ON public.revenue_account_mapping
  FOR ALL USING (org_id = ANY(current_user_org_ids()))
  WITH CHECK   (org_id = ANY(current_user_org_ids()));
```

**Code changes**

1. `lib/fortnox/api/voucher-to-aggregator.ts` — before calling
   `classifyByVat`, look up `revenue_account_mapping` for
   `(business_id, fortnox_account)`. If present, use that subset.
   Else fall back to `classifyByVat` (Wolt/Foodora detection still
   works).

2. Same pattern in `lib/fortnox/resultatrapport-parser.ts:696` (gets
   business_id from caller).

3. `lib/finance/projectRollup.ts` — extend `revenueSubsetFromLines` to
   include 'food_goods' as a recognised subset (only emits to a new
   column if Option δ is chosen in §3.1).

**UI**

Admin-only page at `/admin/v2/customers/[orgId]/revenue-mapping`:
- List all revenue accounts seen on this org's tracker_line_items
  in the last 12 months
- Per account: current default classification + dropdown to override
  (dine_in / takeaway / alcohol / food_goods / other / leave-default)
- Save → INSERT/UPSERT into `revenue_account_mapping`
- Button "Re-aggregate affected periods" → kicks `/api/admin/reaggregate`
  for the periods touching the changed accounts

**Files touched (Phase 2)**

- `sql/M105-REVENUE-ACCOUNT-MAPPING.sql` (new, ~30 lines)
- `lib/fortnox/api/voucher-to-aggregator.ts` (~15-line addition)
- `lib/fortnox/resultatrapport-parser.ts` (~15-line addition)
- `app/admin/v2/customers/[orgId]/revenue-mapping/page.tsx` (new, ~150 lines)
- `app/api/admin/revenue-mapping/route.ts` (new, ~80 lines)
- `lib/finance/projectRollup.ts` (~5-line addition for food_goods)
- Tests: 4-5 new test cases covering override precedence

Total: ~300 LOC + one migration. ~2-3 days of focused work.

### Phase 3 — UI surfaces + 2027-12-31 reversion (deferred)

Only if 2+ customers ask for the food_goods split as a separate KPI.

- `lib/ai/snapshot.ts` — expose food_goods_revenue if Option δ is taken
- `/financials/performance` — add food_goods slice to revenue waterfall
- Dashboard KPI tile updates
- AI prompts updated to recognise food_goods as a distinct concept

**The 2027-12-31 reversion (Sweden's temp 6 % cut ends):**

Add to `lib/sweden/vat.ts`:
```ts
import { TEMP_FOOD_CUT_END } from './vat'
export function foodVatRateAt(date: string): 6 | 12 {
  return date < TEMP_FOOD_CUT_END ? 6 : 12
}
```

Then any classifier that needs to know what VAT rate food *should* be at
a given period can consume this. Currently no code consumes it — it's
a forward-looking helper for when the rate flips back.

Files touched: depends on UI scope at that point. Estimated 1-2 days when
prioritised.

---

## 5. Risks & mitigations

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Phase 1 regex change accidentally drops legitimate Wolt/Foodora takeaway | Low | Medium | Tests explicitly cover Wolt/Foodora/UberEats labels; manual spot-check on Vero May post-deploy |
| Backfill SQL run against wrong business_id | Low | High | Backfill is single-business, single-month, WHERE-pinned to `0f948ac3-…`; manual SELECT sanity check before COMMIT |
| Vero owner notices the dashboard number changed | Medium | Low | Communicate before backfill ("we corrected the April split"); the total revenue is unchanged so the headline number stays |
| PK POS classifier change breaks revenue split for businesses that DO use PK | Low | Medium | `pos_sales` is empty per B.6 → no live PK customers right now; ship anyway; spot-check the day PK customers start ingesting |
| Phase 2 admin UI lets someone misconfigure another customer's account | Low | High | RLS via `current_user_org_ids()` + admin-secret gate on the route; mirrors the M083 pattern |
| Centralised `lib/sweden/vat.ts` becomes a magnet for unrelated tax constants | Medium | Low | Module comment explicitly scopes to "VAT rates only"; new tax modules go under `lib/sweden/<topic>.ts` |
| The 4 call-site fix misses a 5th call site I haven't found | Low | Medium | Pre-merge: rerun `grep -rn 'classifyByVat\|moms\|\b6\s*%' lib/ app/` and verify only the 4 known sites use the rule |
| Future Swedish food VAT change (2028+) is forgotten | Medium | Medium | `lib/sweden/vat.ts` carries `TEMP_FOOD_CUT_END = '2027-12-31'` as a literal; add a TODO comment and a CI check that fails after that date if the constant hasn't been re-evaluated |

## 6. Rollback plan

**Phase 1 code:** revert the PR. The classifier change is purely
in-process; reverting restores prior behaviour. No data corruption
from the code itself.

**Phase 1 backfill:** the SQL is idempotent but not auto-reversible.
Capture pre-backfill state with:

```sql
-- Run BEFORE the backfill; save the result
SELECT id, business_id, period_year, period_month,
       takeaway_revenue, dine_in_revenue
  FROM tracker_data
 WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year = 2026
   AND period_month = 4;

SELECT id, business_id, period_year, period_month,
       fortnox_account, subcategory, amount
  FROM tracker_line_items
 WHERE business_id = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
   AND period_year = 2026
   AND period_month = 4
   AND fortnox_account = 3053;
```

To rollback: UPDATE the rows back to the captured pre-state values.
~5 minutes of manual work.

**Phase 2:** schema migration is additive (`CREATE TABLE`); rolling
back code is enough. Empty table = behaviour identical to Phase 1.
Optional `DROP TABLE revenue_account_mapping` if you want to remove
the schema too.

## 7. Open questions for the owner

1. **§3.1: which option for 6 %-moms default classification?**
   Recommended γ (NULL, no subset).
2. **§3.2: minimal or comprehensive backfill?**
   Recommended minimal (Vero April only).
3. **§3.3: any AI-side communication?**
   Recommended none.
4. **Phase 2 timing:** ship Phase 1 alone first, then Phase 2 a week
   later, OR bundle?
5. **Should Phase 2 admin UI also surface Chicce's chart of accounts
   for proactive configuration** (before Chicce's accountant adds a
   6 %-moms account and the bug fires there too)?
6. **MIGRATIONS.md staleness** (M097 is actually applied; M098/M100/M104
   need verification too): bundle a doc-update PR with Phase 1?
7. **`daily_metrics` missing `dine_in_revenue` / `takeaway_revenue`
   columns** (surfaced during B.3): out of scope per §2, but
   confirm — yes leave out, or yes add to the plan?

## 8. Out of scope (logged for separate plans)

- **Rosali Deli identical-to-Vero data duplication** (surfaced in B.1
  result table). Separate diagnostic; could be a backfill artefact, an
  org-scoped vs business-scoped query bug, or a Rosali-specific Fortnox
  sync issue. Needs its own investigation prompt.
- **`daily_metrics` ↔ `tracker_data` schema asymmetry** (M029 only
  touched `tracker_data`). If PK POS data starts flowing, this becomes
  a real issue. Until then, leave it.
- **Centralising VAT rate references across `lib/revisor/momsrapport.ts`
  reverse-calc**: the math there is correct (Box 12 / 0.06 is just
  arithmetic); the comments are stale. Comment-only fix; tag-along
  with Phase 1 if convenient, otherwise defer.
- **End-of-temp-cut 2028-01-01 reversion**: foodVatRateAt() helper in
  Phase 3 is the forward-looking hook. Real switching logic happens
  closer to the date.

---

*End of plan. ~150-300 LOC code change for Phase 1, one 20-line backfill SQL,
~300 LOC for Phase 2. No new external dependencies. No breaking changes to
customer-facing API contracts (the schema columns stay; only subset values
shift). Headline financial numbers unchanged throughout.*

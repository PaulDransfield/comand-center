# Reply to Claude.ai — current-state investigation complete

The full report is at `docs/investigation/current-state-report.md` (one file,
12 sections in the order you asked for, plus surprises + open questions).
Nothing was changed in code or in the database during the investigation.

Below is a detailed summary you can use as direct input for the design pass.

---

## TL;DR — the five things most likely to force a change in our planned design

### 1. `account_number` (BAS) is unreliably populated by Fortnox today

Fortnox's `/supplierinvoices/{n}` detail returns `account_number = NULL`
until the invoice is bokförd, and even then it's per-customer-config
dependent. Chicce's 2026-05-21 backfill: **3218/3218 rows had
`account_number = NULL`**. The current matcher only survives because
`lib/inventory/suppliers.ts` carries a hand-curated 90-entry supplier-name
dictionary (`EXACT_OVERRIDES`) plus pattern matchers as fallback.

**Impact on the new design:** any categorisation/learning architecture
that treats BAS as the primary signal will fail on cohorts of customers
identical to Chicce. We must either:
- design the new learning layer to work primarily on
  `supplier_name + raw_description` and treat `account_number` as a
  bonus signal, or
- formally cross-reference vouchers (`fortnox_vouchers_cache`, M080) —
  voucher rows reliably carry `Account/Debit/Credit` — and back-fill the
  supplier-invoice-line `account_number` from the matching voucher.

### 2. No supplier master table, no supplier org-nr captured

Suppliers are identified by Fortnox `SupplierNumber` (TEXT) plus a
denormalised `supplier_name_snapshot` on every row. There is **no
`suppliers` table**, no `supplier_org_nr`, no canonical normalised form.

Per `lib/inventory/suppliers.ts:124-126`, even Paul's other restaurant
(`'lawe restaurang ab'`) is hand-tagged `'not_inventory'` — there's no
"this is the same entity in two of our orgs" abstraction.

**Impact on the new design:** the planned cross-customer learning layer
needs a stable supplier identity. Options:
- pull Fortnox `/suppliers/{id}` master (the `supplier` scope is already
  granted) into a new `suppliers` table keyed by `(business_id,
  fortnox_supplier_id)`, capturing org-nr; cross-customer joins on
  `org_nr`.
- or accept name-based fuzzy joining only — slower convergence, more
  noise.

The first option is roughly two days of work (new table + sync cron +
fold `supplier_classifications` / `default_supplier_*` foreign keys).
The second is "do nothing now" but caps the learning loop's
generalisation ceiling.

### 3. Two parallel supplier-invoice ingestion paths coexist

Today `supplier_invoice_lines` is written to from **both**:
- `lib/inventory/backfill-worker.ts` (Fortnox `/supplierinvoices/{n}`
  structured rows) — written with `source='fortnox_row'`.
- `lib/inventory/pdf-extractor.ts` (Claude Vision on the attached PDF) —
  written with `source='pdf_extraction'` via the M078 RPC
  `apply_invoice_pdf_extraction`.

They aren't orchestrated as "API first, fall back to PDF" — they run on
different schedules and both can run for the same invoice. The CLAUDE.md
Session 17 invariant L41 explicitly says "API backfill writes
`source='fortnox_api'` but skips months where a PDF-applied row exists".

The Path B (PDF) extractor has its own cascade (Haiku 4.5 → Sonnet 4.6
escalation in `pdf-extractor.ts:122-171`) and its own validator suite
including non-trivial rescues (credit-note sign-flip, självfaktura inc-VAT
rescue, rebill loose tolerance). All that logic is duplicated from the
Resultatrapport path's `lib/fortnox/validators.ts` + `ai-auditor.ts`.

**Impact on the new design:** the new "invoice extraction & learning"
subsystem needs to formally pick which path wins per (invoice, customer)
and where the learning loop hooks in. Doing both today, with overlap,
is the kind of silent inconsistency that creates "owner sees different
numbers in different views" bugs.

### 4. VAT rates are sprinkled as literals across ~7 files

There is no `lib/sweden/vat.ts` constant. `25 / 12 / 6` appear as:
- regex patterns: `lib/fortnox/classify.ts:121-124`,
  `archive/migrations/M029` re-tag regex
- floating-point comparisons: `lib/pos/personalkollen.ts:307-309`
  (`Math.abs(vat - 0.12) < 0.001`)
- division constants: `lib/revisor/momsrapport.ts:375-377`
  (`Box 11 / 0.12`)
- iteration arrays: `lib/inventory/pdf-extractor.ts:310-336`
  (`for (const vatRate of [25, 12, 6])`)
- validator allowlists: `[0, 6, 12, 25].includes(v)`
- LLM prompt instructions (hard-coded in the SYSTEM_PROMPT text)

**Implication for the temporary 6 % food rate:** the system universally
treats `6 % moms` as "takeaway" (Wolt / Foodora bucket). If Sweden's
dine-in food temporarily moves to 6 %, **every classifier above
silently misroutes dine-in revenue into the takeaway bucket** with no
warning. Restaurants will see takeaway revenue spike and dine-in revenue
collapse — entirely fictitious.

**Impact on the new design:** before any new revenue/cost classifier
ships, centralise VAT-rate knowledge into one module, with the
"alcohol=25 / dine-in=12 / takeaway=6" mapping flagged as
`{ default, current_food_rate_override?: number }`. Even if we don't
change all 7 call sites, the new code paths should consume that module.

### 5. No franchise / master-recipe / multi-location inheritance

The org → business hierarchy IS one-org-many-restaurants, but recipes,
products, suppliers, supplier_classifications, recipe_ingredients,
stock counts, waste log — **all are per `business_id`**. There is no
`master_recipe_id` / `inherited_from_business_id` / "group recipe with
local overrides" abstraction. Two locations in the same org sharing
80 % of their menu would have to duplicate.

The `business_cluster_membership` table (M055) exists but it's for
**cross-business AI peer learning** ("Italian sit-down restaurants in
Stockholm city centre" — used by `lib/forecast/llm-adjust.ts`), not for
inheriting recipes between locations.

**Impact on the new design:** if the planned "recipe costing" subsystem
expects franchise behaviour, the schema needs ~3 columns on `recipes` +
ingredient-override semantics + a UI for "this recipe is inherited from
group X, food cost recomputed against THIS business's prices". That's
real work but cheap to add now versus retrofitting later.

---

## Riskiest unknown

**The exact column shape of `tracker_line_items`.**

It's referenced from at least 8 places (`projectRollup.ts`,
`finance/period-closure.ts`, `archive/migrations/M028/M029/M030`,
`/api/overheads/*`, `verification_tracker_line_items` mirror). Its CREATE
TABLE statement is **not in `sql/` or `archive/migrations/`** anywhere I
could find. The M048 verification harness creates a mirror via
`LIKE tracker_line_items INCLUDING ALL`, which only works if the table
already exists in prod.

This matters because:
- The Resultatrapport apply path writes to it (via `projectRollup`).
- The "category re-sort" learning loop for **P&L items** (not
  supplier-invoice items) operates on its `subcategory` column. The new
  categorisation design might want to use this column or might be
  retiring it.
- CLAUDE.md memory `feedback_check_constraint_drift` lists three
  incidents in 24 h of enum/CHECK drift in this area.

Without authoritative knowledge of what columns and CHECKs exist,
any new write to `tracker_line_items` is a guess. The safe move
before designing: query prod for the actual `\d+ tracker_line_items`
output and add it to the report.

---

## Things I want to flag positively (no design change needed — reuse)

- **Validation chokepoint pattern** (`/api/fortnox/apply`) is exemplary:
  rule-based validators + AI auditor + structured `findings[]` with
  `code` / `severity` / `override_allowed` / `acknowledged_warnings`
  ack flow. The new pipelines should follow the same shape.
- **Idempotency via partial unique indexes + SELECT-then-INSERT** in
  `lib/inventory/matcher.ts` is the right pattern (avoids the PostgREST
  `.upsert({ onConflict })` trap with partial uniques).
- **RLS-via-`current_user_org_ids()` array** + `requireBusinessAccess()`
  per-route gate are well established. New tables should follow.
- **`UXP` token system + `Z` z-index scale** in `lib/constants/tokens.ts`
  are the design source-of-truth. New UI should consume `UXP.*` and
  `Z.*`, not raw hex/numbers.
- **AI cascade pattern** (Haiku first, Sonnet escalation) in
  `pdf-extractor.ts` is generalisable — same shape works for any
  extraction surface that wants the ~3× cost saving on easy inputs.

---

## Open questions worth resolving before design closes

These are the ones from the report I'd want answers to before the
design is final:

1. Are M097 / M098 / M100 / M104 actually applied in prod? `MIGRATIONS.md`
   says "pending" but live code reads from those tables.
2. Is `document_chunks.embedding` populated today? If yes, with which
   provider — we can reuse pgvector for retrieval. If no, we're choosing
   an embedding model from scratch.
3. Are the Fortnox `supplier` and `article` scopes (already granted)
   actually usable? If yes, master-data sync is a few days of work and
   unlocks the supplier-identity story above.
4. Does the new design need franchise-master-recipe behaviour, or are
   per-business recipes acceptable for the first version?
5. Will Sweden's temporary 6 % food rate land within the timeframe of
   this build? If yes, the VAT-constant refactor should be a Phase 0
   foundation item, not a "later".

---

*Report file: `docs/investigation/current-state-report.md`. ~50 source
files cited. No code or DB changes.*

# MIGRATIONS.md — CommandCenter Database Change Log
> Last updated: 2026-06-06 | Session 25: M128 + M130 + M132 + M135 applied during the ingestion ledger + recipe-import-draft + global-enrichment schema ship. Audit-confirmed via diagnostic query.
> Record every SQL change run in Supabase here. Never edit old entries — add new ones.

---

## Applied — 2026-06-10 (views security hardening — SECURITY INVOKER sweep)

### M144 — remaining public views: SECURITY INVOKER (advisor sweep) ✅ applied 2026-06-10
**File:** `sql/M144-VIEWS-SECURITY-INVOKER-SWEEP.sql`
**Purpose:** Clears the advisor's "SECURITY DEFINER view" finding on `invoices_with_status`, then sweeps every remaining public view so the whole class is closed.
**Views:** `invoices_with_status` (computed status/overdue over `invoices`; its `CREATE VIEW` exists only in the DB, so this ALTER is the option's source of truth), `v_forecast_mape_by_surface` (M065 base MAPE view).
**Safe:** readers use service_role (bypasses RLS). M065 source updated to bake in `WITH (security_invoker = on)`. **Verified live: 0 public views left without `security_invoker=on`.**

### M143 — forecast metric views: SECURITY INVOKER ✅ applied 2026-06-10
**File:** `sql/M143-FORECAST-VIEWS-SECURITY-INVOKER.sql`
**Purpose:** Clears Supabase security-advisor "SECURITY DEFINER view" finding on `v_forecast_confidence_calibration` (and its three M070 siblings). `ALTER VIEW … SET (security_invoker = on)` so the views enforce the querying user's RLS/permissions, not the owner's.
**Views:** `v_forecast_mape_by_horizon_bucket`, `v_forecast_confidence_calibration`, `v_forecast_mape_rolling_28d`, `v_forecast_horizon_confidence_breakdown`.
**Safe:** only reader is the admin forecasting route via service_role (bypasses RLS regardless). M070 source updated to bake `WITH (security_invoker = on)` into the CREATEs so a re-apply stays compliant. Verified live: all 4 views report `reloptions = {security_invoker=on}`.

---

## Applied — 2026-06-06 (Session 25: ingestion ledger + bug fix + global enrichment schema)

### M135 — ingestion_log + fortnox_supplier_invoices.ingestion_status ✅ applied 2026-06-06
**File:** `sql/M135-INGESTION-LEDGER.sql`
**Purpose:** Phase 1 of `docs/INGESTION-PIPELINE-RELIABILITY-PLAN.md`. Adds a per-row completeness flag on every Fortnox-sourced supplier invoice plus a truthful audit ledger of every external API call. Powers Phase 2 file-id resolution (supplier-sync inline + dedicated `fortnox-pdf-backfill` cron) and Phase 3 daily coverage check.
**Schema:**
- `ingestion_log(id, source, resource, operation, business_id, org_id, started_at, finished_at, status CHECK IN ('open','complete','failed'), error, expected_fields TEXT[], populated_fields TEXT[], context JSONB, rows_processed)`
- `fortnox_supplier_invoices.ingestion_status TEXT NOT NULL DEFAULT 'header_only'` + CHECK `IN ('header_only','complete','failed')`
- `fortnox_supplier_invoices.ingestion_meta JSONB` — per-row record of which fields were expected vs populated at write time
- Truthful backfill on existing rows: `complete` where `file_id IS NOT NULL`, else `header_only`
- Indexes on ledger for the coverage-check query path
**Idempotent.** All ADD COLUMN / ADD CONSTRAINT wrapped in IF NOT EXISTS guards.

### M130 — products.created_via allows 'recipe_import_draft' ✅ applied 2026-06-06
**File:** `sql/M130-PRODUCTS-RECIPE-IMPORT-DRAFT.sql`
**Purpose:** CHECK constraint widen so the recipe editor's "Add ingredient → New product" path can create placeholder products (no supplier match yet, waiting for an invoice). Matcher pairs them automatically when an invoice arrives with the same `(supplier, normalised_description, unit)` signature. Items + counts API both flag these as `is_recipe_sourced = true` so the no_article / no_price / no_supplier "Needs attention" warnings are suppressed until the match lands.
**Schema:**
- `ALTER TABLE products DROP CONSTRAINT IF EXISTS products_created_via_chk`
- `ADD CONSTRAINT products_created_via_chk CHECK (created_via IN ('auto_exact', 'auto_fuzzy', 'owner_review', 'manual', 'fortnox_backfill', 'recipe_promotion', 'recipe_import_draft'))`
**Idempotent.** Pure CHECK relaxation; no row rewrites.
**Note:** This was discovered as a missed migration during the Aragosta Pasta create flow on 2026-06-06 — surfaced as "new row for relation \"products\" violates check constraint products_created_via_chk". The codebase had been writing the new value since M130 was written but the CHECK in production still held the M075/M123 list.

### M128 — products external-catalogue link ✅ applied 2026-06-06
**File:** `sql/M128-PRODUCTS-EXTERNAL-CATALOGUE.sql`
**Purpose:** Link customer products to public supplier catalogues (Spendrups, Systembolaget) for thumbnail + spec enrichment when the regular `(fortnox_number, article_number)` join misses. Supplier-article batch lookup falls back through these columns.
**Schema:**
- `ALTER TABLE products ADD COLUMN IF NOT EXISTS external_catalogue_source TEXT` (sentinel: `'SPENDRUPS'`, `'SYSTEMBOLAGET'`, etc.)
- `ALTER TABLE products ADD COLUMN IF NOT EXISTS external_catalogue_article TEXT`
- Partial index `products_external_catalogue_idx ON (external_catalogue_source, external_catalogue_article) WHERE external_catalogue_source IS NOT NULL`
**Idempotent.** Application code has a defensive fallback (`supplier-article/batch/route.ts:53-54`) that catches missing-column errors and retries without it, so this was non-blocking — application just missed an enrichment path.

### M132 — global product enrichment (Phase 1 schema) ✅ applied 2026-06-06
**File:** `sql/M132-GLOBAL-PRODUCT-ENRICHMENT.sql`
**Purpose:** Phase 1 of `docs/GLOBAL-PRODUCT-ENRICHMENT-PLAN.md` — SCHEMA ONLY. Lets customer A's owner-saved physical-truth refinements (pack_size, base_unit, weight per piece, density, category) flow back to a shared layer so customer B inherits them on day 1. Pricing, waste %, aliases, recipes STAY per-business.
**Schema:**
- `supplier_articles.refined_pack_size / refined_base_unit / refined_weight_per_piece_g / refined_density_g_per_ml / refined_category / refined_confidence smallint DEFAULT 0 / refined_last_updated_at`
- CHECK: `refined_confidence BETWEEN 0 AND 2` (0=none, 1=single-customer, 2=verified-by-2+)
- CHECK: `refined_category IN ('food','beverage','alcohol','cleaning','disposables','packaging','equipment','other')` or NULL
- `supplier_article_refinement_log(id bigserial, supplier_fortnox_number, article_number, business_id, field, value JSONB, set_at)` with FK to `supplier_articles` ON DELETE CASCADE
- CHECK on log: `field IN ('pack_size','base_unit','weight_per_piece_g','density_g_per_ml','category')` — whitelist
- `businesses.share_refinements_with_platform BOOLEAN NOT NULL DEFAULT true` — opt-out flag for Settings
- Indexes on log for (article), (business), (field)
**Idempotent.** All ADD COLUMN / constraints wrapped in IF NOT EXISTS / DO NOT EXISTS guards.
**Note:** Phase 2 (write hook + read overlay) hasn't been built yet — this is dormant schema until then.

### Migration audit run 2026-06-06
A diagnostic query verified the in-DB state of M119–M135 against `information_schema` + `pg_constraint`. Result: 15/17 PASS, only M128 + M132 MISS — both applied immediately after audit. Subsequent re-run would show 17/17 PASS.

---

## Applied — 2026-06-01 to 2026-06-02 (Session 24: prep + order pipeline)

### M116 — prep_sessions + prep_session_lines ✅ applied 2026-06-01
**File:** `sql/M116-PREP-SESSIONS.sql`
**Purpose:** Persistence for prep-list sessions so the kitchen can check off lines cross-device. Owner enters dishes×portions, system freezes the aggregated raw-ingredient + sub-recipe lines as `prep_session_lines`; chef toggles `checked_at` per line; session closes via `completed_at = NOW()`.
**Schema:**
- `prep_sessions(id, org_id, business_id, name, inputs JSONB, created_at, created_by, completed_at)`
- `prep_session_lines(id, session_id, kind CHECK IN ('component','product'), entity_id, name_snapshot, total_qty, unit, uncertain CHECK IN ('sub_no_yield','unit_mismatch','cycle')|NULL, uncertain_reason, source_recipe_ids UUID[], checked_at, checked_by, position, created_at)`
- Partial unique index `prep_sessions_one_active_idx ON (business_id) WHERE completed_at IS NULL` — enforces one active per business
- Standard indexes on `(business_id, created_at DESC)` and `(session_id, position)`, plus `(session_id) WHERE checked_at IS NULL` for "open lines" queries
- RLS via `current_user_org_ids()` on parent; child policy via EXISTS-on-parent
**Idempotent.** All CREATE TABLE / INDEX / POLICY use IF NOT EXISTS or DROP+CREATE.

### M117 — recipes.portions_per_cover ✅ applied 2026-06-01
**File:** `sql/M117-RECIPE-PORTIONS-PER-COVER.sql`
**Purpose:** Per-dish mix share for the prep-list covers auto-fill. 0.15 = 15 % of guests order this dish. Drives `qty = round(covers × share)` per dish when owner clicks Apply on the covers card.
**Schema:**
- `ALTER TABLE recipes ADD COLUMN IF NOT EXISTS portions_per_cover NUMERIC`
- `CHECK (portions_per_cover IS NULL OR (portions_per_cover >= 0 AND portions_per_cover <= 10))` — bounds prevent the "typed 15 thinking percent" typo (would predict 3,000 portions for 200 covers)
- Constraint wrapped in `DO $$ IF NOT EXISTS pg_constraint $$` block for re-run safety
**Idempotent.** NULL = no share set; dish skips auto-fill. UI translates fraction↔percentage at the boundary.

### M118 — prep_pre_orders ✅ applied 2026-06-01
**File:** `sql/M118-PREP-PRE-ORDERS.sql`
**Purpose:** Advance customer commitments (party-of-N pre-ordering specific dishes for a future service date). Folds into the Apply math: `freeCovers = max(0, covers − sum(party_sizes))`; share-driven qty per dish on freeCovers; pre-order items added on top per-dish.
**Schema:**
- `prep_pre_orders(id, org_id, business_id, service_date, party_name, party_size CHECK >0, notes, items JSONB CHECK array, created_at, created_by, updated_at, archived_at)`
- Partial index `(business_id, service_date) WHERE archived_at IS NULL` for the prep-page query path
- Soft delete via `archived_at` preserves audit history
- RLS via `current_user_org_ids()`
- `set_updated_at` trigger
**Idempotent.** Standard pattern.

---

## Applied — 2026-05-31 (Session 22: P2.0 + Fix 1/2 + Ticket 1)

### M108 — P2.0 provenance (account_source + context CHECK widen) ✅ applied 2026-05-30
**File:** `sql/M108-P20-PROVENANCE.sql`
**Purpose:** Schema dependencies for P2.0 voucher back-fill operations.
**Schema:**
- Added `supplier_invoice_lines.account_source TEXT NOT NULL DEFAULT 'fortnox_row'` + CHECK constraint allowing `('fortnox_row', 'voucher_backfill', 'owner_correction')`
- Partial index `supplier_invoice_lines_account_source_idx ON (business_id, account_source) WHERE account_source != 'fortnox_row'` for audit queries
- Widened `inventory_review_outcomes.context` CHECK from `('needs_review', 'audit_sample')` → `('needs_review', 'audit_sample', 'rebate_guard_backfill')`
**Pre-commit verified:** 2,498 needs_review + 1 audit_sample existing rows — no strand risk.
**Idempotent.** ADD COLUMN IF NOT EXISTS + DROP+ADD CHECK pattern.

### One-off data backfills (NOT numbered migrations — single-business, single-period fixes)

These were applied via Supabase SQL Editor with BEGIN→verification→COMMIT pattern. Mirror of the M-migration approach for schema, but kept un-numbered because they don't define a re-runnable rollup.

#### `sql/p20-voucher-rebate-backfill-APPLY.sql` ✅ applied 2026-05-30
**Purpose:** Voucher-as-ground-truth back-fill. Three atomic operations on Chicce + Vero `supplier_invoice_lines`:
- **Op 1:** Set `account_number` + `account_source='voucher_backfill'` from `fortnox_vouchers_cache` single-expense-account vouchers (901 Chicce + 7,051 Vero lines)
- **Op 2a:** Rebate-guard pattern `~* '(avtalsrabatt|^rabatt|^pant\M|...)'` flipped lines to `match_status='not_inventory'` + cleared alias (117 Chicce + 576 Vero lines)
- **Op 2b:** Inserted `inventory_review_outcomes` row per affected alias (17 Chicce + 0 Vero) with `context='rebate_guard_backfill'`
- **Op 2c:** Called `product_aliases_record_correction(alias_id, 2)` per affected alias — mirrors runtime `/correct-attribution` path, bumps `corrections_against` + `last_corrected_at` (17 RPC calls, all landed at corrections=1, zero demotions)
**Idempotent.** Re-running is no-op via `account_number IS NULL` + `match_status != 'not_inventory'` + `NOT EXISTS rebate_guard_backfill outcome` guards. All 8 verification metrics matched predicted figures exactly. See FIXES.md §0ct-1.

#### `sql/p20-fix2-deposit-logistics-DRY/APPLY.sql` ✅ applied 2026-05-31
**Purpose:** Extended description rule (Fix 2). Flipped needs_review lines to not_inventory where `raw_description` matches the broader deposit/logistics/rebate pattern (added arms: `^pantgr[öo]n\M`, `^eur[-\s]?pall\M`, `^plastpall\M`, `^pallet\M`, `^halvpall\M`, `^eng[åa]ngspall\M`, `^kolli\M`, `^pba\s+retur`, `^srs\s+(retur|back)`, `^retur\s+srs`, `^distribution\s+`, `^leveransavgift\M`, `^plockavgift\M`, `^frakt\M`, `^milj[öo]rabatt\M` alongside the original P2.0 arms).
**Result:** 636 Chicce + 991 Vero lines flipped. Zero false positives (Direction-B clean across 10,579 matched lines). Idempotency = 0.
**Companion code:** `lib/inventory/description-rules.ts` + matcher Gate 0b consume the same pattern so future invoice lines hit the rule at ingestion. See FIXES.md §0ct-3.

#### `sql/p20-paydown-ticket1-backfill-APPLY.sql` ✅ applied 2026-05-31
**Purpose:** Reliability paydown Ticket 1. Backfilled `fortnox_supplier_invoices.voucher_series` + `voucher_number` columns (M098-added but 100% NULL) from `raw_data.Vouchers` JSONB. Filter `v->>'ReferenceType' = 'SUPPLIERINVOICE' LIMIT 1` mirrors the shared TS helper `lib/fortnox/extract-voucher-ref.ts` used by the supplier-sync cron.
**Result:** Chicce 725 populated (23 unrecoverable, no SUPPLIERINVOICE ref in JSONB); Vero 995 populated (17 unrecoverable). V3 load-bearing guard = 0 (extracted ref is always SUPPLIERINVOICE, never SUPPLIERPAYMENT). Spot-check confirmed 3 multi-ref invoices picked SUPPLIERINVOICE over SUPPLIERPAYMENT correctly. See FIXES.md §0ct + `docs/investigation/p20-reliability-paydown.md`.
**Idempotent.** `WHERE voucher_series IS NULL AND raw_data ? 'Vouchers' AND EXISTS (...SUPPLIERINVOICE)` guard.

#### `sql/backfill-vero-april-vat-misrouting.sql` ✅ applied 2026-05-30
**Purpose:** One-off corrective for VAT misrouting bug (`docs/investigation/vat-misrouting-verdict.md`). Moved 48,468 SEK from Vero April 2026 `tracker_data.takeaway_revenue` to unclassified (stays in `revenue`, removed from subset). Account 3053 ("Försäljning varor 6% moms Sv") now subcategory=null instead of subcategory='takeaway'. Companion code: `lib/sweden/vat.ts` + 5 inference sites converted. See `docs/investigation/vat-hotfix-status.md` for status verdict.

---

## Applied — 2026-05-30 (ledger reconciliation, no SQL run)

Pre-Phase-1 audit (`scripts/diag-phase1-prereq.mjs`, read-only) cross-checked the
ledger against `pg_tables` and information-schema columns on prod. Findings:

- **M087** (`products.pack_size` + `base_unit`): ✅ applied. Verified: a sample
  `products` row returned `pack_size=2500, base_unit='g'`. Entry below moved
  from "Pending" to applied here; no SQL run today.
- **M088** (`fx_rates`): ✅ applied. Verified: 37 rows present. Moved likewise.
- **M097** (`pos_menu_items` + `pos_sales`): ✅ applied. Verified: both tables
  exist (both empty — no live POS feeds yet). Moved.
- **M098** (`fortnox_supplier_invoices` + `fortnox_sync_state`): ✅ applied.
  Verified: `fortnox_supplier_invoices` has 1,760 rows; `fortnox_sync_state`
  has 2 rows. Moved.
- **M099** (`inventory_review_suggestions` + `inventory_review_outcomes`):
  ✅ applied. Verified: both tables exist with 1,000+ rows each (PostgREST
  page cap). Was missing from this ledger entirely. Brief entry added below.
- **M100** (scheduling — actual tables `staff_shifts`, `staff_profiles`,
  `staff_shift_templates`, `schedule_ai_suggestions`,
  `staff_performance_signals`): ✅ applied. Verified: `staff_shifts` 1,655
  rows, `staff_profiles` 131, `staff_shift_templates` 28,
  `schedule_ai_suggestions` 40. Was missing from this ledger entirely.
- **M104** (`review_insights_cache`): ⏳ genuinely pending. Verified MISSING.
  A separate `review_insights` table exists (2 rows) but is not the same
  thing. Entry kept in "Pending" below.

This is a **doc-only commit**. No SQL was run on prod for this update.

**Known broader drift (out of scope for this commit):** entries M075, M076,
M077, M078, M079, M080, M063, M064, M065, M067, M068 are still marked
"pending application" further down in this file. Most are almost certainly
applied (the live system reads from `product_aliases` / `invoice_pdf_extractions`
/ `fortnox_vouchers_cache` every day, which would 500 if their tables were
missing). A full ledger reconciliation pass would verify each via
`pg_tables` and flip labels — deferred to a follow-up doc PR. Today's
scope is narrowly the four migrations gating Phase 1 work + the two
missing entries (M099/M100).

---

## Applied — 2026-05-25 (scaling audit + risk-horizon)

### M103 — Stripe webhook idempotency hardening ✅ applied 2026-05-25
**File:** `sql/M103-STRIPE-WEBHOOK-IDEMPOTENCY.sql`
**Purpose:** Closes the silent-underbilling bug class. Pre-M103 the webhook inserted a dedup row BEFORE handleEvent; if Vercel killed the function mid-handler, the next Stripe retry treated the row as already-processed and silently skipped. M103 separates "claimed for processing" from "completed processing" via two columns + two RPCs.
**Schema:**
- Added `claimed_at TIMESTAMPTZ` to `stripe_processed_events` (existed)
- Dropped `NOT NULL` + `DEFAULT now()` on `processed_at` so new code can store NULL during in-flight processing
- Backfilled `claimed_at = processed_at` for existing rows (all represent completed events under old semantics)
**RPCs:**
- `claim_stripe_event(p_event_id, p_event_type, p_stale_ms=60000)` → returns `'claimed'` | `'duplicate'` | `'concurrent'` | `'stale_takeover'`
- `mark_stripe_event_processed(p_event_id)` → sets `processed_at = now()` after handleEvent succeeds
**Companion code:** `/api/stripe/webhook` rewritten to use the claim flow. `'concurrent'` returns 429 (Stripe retries); `'stale_takeover'` reruns handler (idempotent on Stripe data); `'claimed'` is the normal path.
**Initial fix needed:** First version assumed `created_at` column existed — production schema only has `event_id`, `event_type`, `processed_at`. Defensive DO-block ADD COLUMN + NULL drop pattern works against actual schema. Idempotent.

### M102 — ai_request_log archive table ✅ applied 2026-05-25
**File:** `sql/M102-AI-REQUEST-LOG-ARCHIVE.sql`
**Purpose:** Weekly retention cron used to hard-delete `ai_request_log` rows >365 days. Lost audit trail for compliance + multi-year cost analysis. M102 adds a per-day rollup table so we keep 7+ years cheaply (~99% smaller than raw rows).
**Schema:**
- `ai_request_log_archive(date, org_id, request_type, model, request_count, input_tokens_total, output_tokens_total, cost_usd_total, cost_sek_total, duration_ms_total, archived_at)`
- PK `(date, org_id, request_type, model)` — one row per day per org per type per model
- Indexes on `(org_id, date DESC)` + `(date DESC, model)`
- RLS via `current_user_org_ids()`
**RPC:** `upsert_ai_log_archive(p_date, p_org_id, p_request_type, p_model, p_request_count, p_input_tokens_total, p_output_tokens_total, p_cost_usd_total, p_cost_sek_total, p_duration_ms_total)` with SUM-on-conflict semantics so partial cron reruns aggregate correctly.
**Companion code:** `/api/cron/ai-log-retention` rewritten to archive-then-delete in `BATCH_SIZE=5000` chunks. Aborts run on archive failure — never deletes unarchived data.
**Idempotent.**

### M101 — Scaling indexes + extraction sweeper RPC hardening ✅ applied 2026-05-25
**File:** `sql/M101-SCALING-INDEXES-AND-RPC-HARDENING.sql`
**Purpose:** Audit found hot-path queries doing sequential scans on tenant-scoped tables. Adds 5 covering indexes + hardens `list_ready_extraction_jobs` RPC with `FOR UPDATE SKIP LOCKED` so concurrent sweepers can't return overlapping job sets.
**Indexes (all defensive — wrapped in DO-blocks that introspect column names because archive/migrations DDL doesn't always match prod):**
- `idx_hourly_metrics_biz_date ON hourly_metrics (business_id, business_date)`
- `idx_overhead_cache_lookup ON overhead_drilldown_cache (business_id, period_year, period_month, category)`
- `idx_supplier_class_biz_num ON supplier_classifications (business_id, supplier_fortnox_number)`
- `idx_daily_metrics_org_biz_date ON daily_metrics (org_id, business_id, business_date)`
- `idx_monthly_metrics_org_biz_period ON monthly_metrics (org_id, business_id, year, month)`
**RPC change:** `list_ready_extraction_jobs(max_jobs)` switched from `LANGUAGE sql STABLE` to `LANGUAGE plpgsql` (required for `FOR UPDATE SKIP LOCKED` in body). Preserved `RETURNS SETOF extraction_jobs` signature so existing callers aren't broken.
**Initial fix needed:** First version assumed `business_date` column existed on `hourly_metrics`; production schema differs from M071 DDL. Rewrote to introspect `information_schema.columns` and pick the actual date column (tries `business_date` → `service_date` → `date`). Each step emits `RAISE NOTICE` so the operator sees which indexes landed vs were skipped.

---

## Pending — apply when ready

### M104 — Review insights cache ⏳ pending application
**File:** `sql/M104-REVIEW-INSIGHTS-CACHE.sql`
**Purpose:** 24h-cached pre-computed insights for the /reviews dashboard cards (5 things to improve + 5 things customers love). Derived from `review_themes` (LLM-extracted, persistent across the Google TOS 30-day raw-text prune). Without this cache, every /reviews load re-runs the LLM synthesis (~$0.005/load).
**Schema (per file — not verified on prod since the table doesn't yet exist):**
- `review_insights_cache(id, business_id, org_id, cache_key, payload JSONB, generated_at, ai_model, tokens_input, tokens_output)`
- UNIQUE `(business_id, cache_key)` for upsert
- TTL: 24h, enforced by cache_key + generated_at check at read time
**Companion code:** /reviews dashboard + `/api/reviews/insights` consume the cache opportunistically with a fall-back to live LLM synthesis when stale or missing.
**Verified MISSING via `pg_tables` 2026-05-30.** Apply when reviewing the
/reviews page surface; not blocking other work.

### M098 — Fortnox supplier-invoices local cache ✅ APPLIED — verified 2026-05-30
**File:** `sql/M098-FORTNOX-SUPPLIER-INVOICES-CACHE.sql`
**Status update:** Was marked "pending application" in this ledger pre-2026-05-30. The
pre-Phase-1 audit found `fortnox_supplier_invoices` populated with 1,760 rows and
`fortnox_sync_state` with 2 rows. Table exists in prod. **Original entry preserved below
for the schema + companion-code reference.**
**File:** `sql/M098-FORTNOX-SUPPLIER-INVOICES-CACHE.sql`
**Purpose:** Read-path scaling. Pre-M098, every dashboard render hit Fortnox `/supplierinvoices` live (25 req/5sec rate limit, 500-1500ms per call). Fine at 2 customers, breaks at customer #3+ when bursts (lunch-hour traffic) exceed the budget. M098 adds a local cache populated by a daily sync cron; user-facing reads (recent-invoices feed, dashboard card, /invoices page, drilldown) hit the cache. file_id fetched lazily on first PDF view, then persisted.
**Schema:**
- `fortnox_supplier_invoices(id, org_id, business_id, given_number, invoice_number, supplier_name, supplier_number, supplier_normalised, invoice_date, bookkeeping_date, due_date, total, currency, vat, balance, final_pay_date, voucher_series, voucher_number, file_id, file_id_fetched_at, has_pdf GENERATED, comments, cancelled, raw_data JSONB, first_seen_at, last_synced_at)`
- UNIQUE `(business_id, given_number)` — full unique (not partial), safe for `.upsert({ onConflict: 'business_id,given_number' })`
- Indexes on `(business_id, invoice_date DESC)`, `(business_id, supplier_normalised)`, `(business_id, voucher_series, voucher_number) WHERE voucher_series IS NOT NULL`, `(business_id, has_pdf) WHERE has_pdf`
- `fortnox_sync_state(business_id, resource, last_synced_at, last_cursor_date, rows_synced, last_error, created_at, updated_at)` — PK `(business_id, resource)`
- RLS via `current_user_org_ids()` on both
**Companion code:**
- `/api/cron/fortnox-supplier-sync` — daily cron at 06:10 UTC. For each connected Fortnox integration: read cursor from `fortnox_sync_state`, paginate `/supplierinvoices?fromdate=cursor-1d&todate=today&limit=500`, upsert to cache, update cursor. First-time backfill goes 12 months back.
- `vercel.json` — cron entry at 06:10 UTC.
- `/api/integrations/fortnox/recent-invoices` — refactored: tries M098 first (when `last_synced_at < 26h`), falls back to live Fortnox if empty/stale. Writes through to the 5-min in-app cache.
- `/api/integrations/fortnox/invoice-pdf` — refactored: looks up `file_id` from M098 cache, 302 directly when present. Live detail fetch only when `file_id` is null — then persists it back.
**Idempotent.**
**Required after apply:** trigger the cron once manually to seed the cache: `curl -X GET https://comandcenter.se/api/cron/fortnox-supplier-sync -H "Authorization: Bearer $CRON_SECRET"`. First run takes longer (12-month backfill); subsequent daily runs are incremental.

### M097 — POS menu items + sales (variance loop foundation) ✅ APPLIED — verified 2026-05-30
**Status update:** Was marked "pending application" pre-2026-05-30. Pre-Phase-1 audit
found `pos_menu_items` and `pos_sales` both exist (both empty — no live POS feeds yet).
Original entry preserved below.
**File:** `sql/M097-POS-SALES.sql`
**Purpose:** Closes the inventory loop. Adds `pos_menu_items` (dishes the restaurant sells, optionally linked to a recipe) and `pos_sales` (per-ticket OR per-week aggregate sale rows). Enables `/inventory/variance` to compute theoretical product draw (POS sales × recipes) vs actual (purchases − waste).
**Schema:**
- `pos_menu_items(id, org_id, business_id, pos_provider, pos_item_id, name, recipe_id FK recipes, price_inc_vat, archived_at, created_at, updated_at)`
- Partial unique index `(business_id, pos_provider, pos_item_id) WHERE pos_item_id IS NOT NULL` for connector idempotency
- Partial unique index `(business_id, LOWER(name)) WHERE pos_provider='manual' AND archived_at IS NULL` for manual-entry dedup
- `pos_sales(id, org_id, business_id, pos_item_id FK pos_menu_items, sold_at, sold_date GENERATED, quantity, net_revenue, source, source_ref, notes, created_at, updated_at)`
- Partial unique index `(business_id, source, source_ref) WHERE source_ref IS NOT NULL` (connector idempotency)
- Partial unique index `(business_id, pos_item_id, sold_date) WHERE source='manual'` (manual weekly entries)
- RLS via `current_user_org_ids()` on both tables
**Companion code:**
- `/api/inventory/pos-menu-items` (GET + POST) and `/api/inventory/pos-menu-items/[id]` (PATCH + DELETE)
- `/api/inventory/pos-sales` (GET + POST) and `/api/inventory/pos-sales/[id]` (DELETE)
- `/api/inventory/variance` (GET) — uses `lib/inventory/variance.ts::computeVariance` which loads recipes, expands POS sales × recipes into per-product theoretical draw, sums purchases + waste, returns variance rows + summary
- `/inventory/sales` page — manual weekly entry grid
- `/inventory/variance` page — theoretical vs actual dashboard
- Nav additions in `lib/nav/areas.ts` (Sales, Variance)
**Idempotent.**
**PostgREST partial-index trap:** the manual-weekly partial unique index can't be used by `.upsert({ onConflict })`. Manual sales POST does SELECT-then-INSERT-or-UPDATE with 23505 retry per `feedback_postgrest_upsert_partial_indexes.md`.

### M088 — fx_rates table ✅ APPLIED — verified 2026-05-30
**Status update:** Was marked "pending application" pre-2026-05-30. Pre-Phase-1 audit
found `fx_rates` populated with 37 rows. Original entry preserved below.
**File:** `sql/M088-FX-RATES.sql`
**Purpose:** Daily currency-to-SEK rates so cost calc (recipe-cost.ts) can convert non-SEK invoice lines. ECB daily XML is the source; daily cron at `/api/cron/fx-rates-update` (17:00 UTC) fetches + upserts.
**Schema:**
- `fx_rates(id BIGSERIAL, rate_date DATE, currency TEXT, rate_to_sek NUMERIC, source TEXT='ecb', fetched_at)`
- UNIQUE (rate_date, currency, source) — full constraint, safe for upsert ON CONFLICT
- Index (currency, rate_date DESC) for at-or-before lookups
- Seeds SEK=1.0 system row for the trivial case
**Companion code:**
- `lib/inventory/fx.ts` — `loadFxIndex` + `getFxRate` + `toSek` helpers
- `lib/inventory/recipe-cost.ts` — `getProductLatestPrices` accepts optional `FxIndex`, populates `latest_price_sek` + `fx_rate_used` per product
- `/api/cron/fx-rates-update/route.ts` — daily ECB ingestor, EUR direct + cross-rate USD/NOK/DKK/GBP
- `vercel.json` — daily cron at 17:00 UTC (after ECB publishes)
**Idempotent.**
**Required after apply:** trigger the cron once manually to seed today's rates: `curl -X GET https://comandcenter.se/api/cron/fx-rates-update -H "Authorization: Bearer $CRON_SECRET"`

### M087 — products.pack_size + base_unit ✅ APPLIED — verified 2026-05-30
**Status update:** Was marked "pending application" pre-2026-05-30. Pre-Phase-1 audit
found `products.pack_size` + `products.base_unit` populated (sample row returned
pack_size=2500, base_unit='g'). Original entry preserved below.
**File:** `sql/M087-PRODUCT-PACK-SIZE.sql`
**Purpose:** Unit conversion for recipes. Restaurant recipes are in g/ml/st, invoices are per pack (1kg bag at 56 kr per ST). Without pack data, 20g of garlic costs 1118 kr instead of 1.12 kr. Both columns nullable so legacy products fall back to 1:1 + warning.
**Schema:**
- `products.pack_size NUMERIC` (how many base units per invoice unit, e.g. 1000 for a 1kg bag where base_unit='g')
- `products.base_unit TEXT CHECK IN ('g','ml','st')`
- `products.pack_size CHECK > 0`
**Companion code:**
- `lib/inventory/unit-conversion.ts` — `canonicalUnit`, `convertQuantity` (g↔kg, ml↔l), `parseProductPackSize` (regex parses "4,1 kg" etc from product names with Swedish comma decimals)
- `lib/inventory/recipe-cost.ts` — `costPerBase = unit_price / pack_size`, `line_cost = convertedQty × costPerBase`. Auto-parses name when DB is null.
- `lib/inventory/matcher.ts` — `createProductFromLine` pre-fills pack_size + base_unit from the canonical name when bulk-review creates a product
- `app/api/inventory/items/[id]/route.ts` PATCH accepts pack_size + base_unit; GET returns them
- `app/api/inventory/items/[id]/pack-suggest/route.ts` (NEW) — returns parser suggestion for the per-product "Detect & apply" button
- `app/api/inventory/items/backfill-pack-size/route.ts` (NEW) — bulk endpoint: walks every product without pack_size, applies the parser, saves
- `/inventory/items/[id]` page — header gains Pack size + base unit inputs + "Detect & apply" banner when missing
- `/inventory/items` page — "Detect pack size for all" button (calls backfill-pack-size)
- `/inventory/recipes` drawer — Edit Product expand on each ingredient gains pack-size + base-unit fields
**Idempotent.**

---

### M086 — recipe_ingredients sub-recipes ✅ applied 2026-05-24
**File:** `sql/M086-SUBRECIPES.sql`
**Purpose:** Recipes-inside-recipes. A dish is built from raw products PLUS several prep recipes (tomato sauce, pizza dough). Each ingredient row now points at EITHER a product OR another recipe.
**Schema:**
- `recipe_ingredients.subrecipe_id UUID` nullable, FK to recipes(id) ON DELETE RESTRICT (prep recipes can't be deleted while a dish references them)
- `product_id` became nullable; CHECK enforces exactly-one-of `(product_id, subrecipe_id)`
- CHECK `subrecipe_id != recipe_id` (cheapest cycle prevention)
- Old UNIQUE(recipe_id, product_id) dropped; replaced with TWO partial unique indexes — `WHERE product_id IS NOT NULL` and `WHERE subrecipe_id IS NOT NULL`
- These partials trigger the PostgREST partial-index trap on `.upsert({ onConflict })` — POST endpoint switched to SELECT-then-INSERT-or-UPDATE (same fix pattern as M075/product_aliases)
**Cost model:** sub-recipe yield unit is `portions`. Cost per portion = sub.food_cost / sub.portions. Tomato Sauce yields 4 portions @ 60 kr → 15 kr/portion → 0.5 portions of Tomato Sauce in Margherita = 7.50 kr contribution.
**Cycle detection:** 3 layers — DB CHECK (self-ref), API POST cycle walker (transitive check via `wouldCreateCycle`), cost helper compute-time guard (skip + flag).
**Companion code:** `lib/inventory/recipe-cost.ts` (recurses with ancestor stack), `lib/inventory/matcher.ts`, recipe drawer + picker UI tabs.

### M085 — supplier_invoice_lines.currency ✅ applied 2026-05-23
**File:** `sql/M085-INVOICE-LINE-CURRENCY.sql`
**Purpose:** Track invoice currency. EUR/USD invoices were silently treated as SEK, inflating food cost 11×. Default 'SEK'; PDF extractor detects from invoice header.
**Schema:** `supplier_invoice_lines.currency TEXT NOT NULL DEFAULT 'SEK' CHECK IN ('SEK','EUR','USD','NOK','DKK','GBP')`. Index on (business_id, currency) WHERE currency != 'SEK'.
**Companion code:** `lib/inventory/pdf-extractor.ts` SYSTEM_PROMPT + RECORD_TOOL.input_schema.header.currency. After extraction, post-pass UPDATEs all rows for that invoice with detected currency. PATCH `/api/inventory/lines/[id]` accepts currency edits. Product detail history table + recipe drawer expose editable currency dropdown.

### M084 — recipes + recipe_ingredients ✅ applied 2026-05-23
**File:** `sql/M084-RECIPES.sql`
**Purpose:** Real persistence for recipe cost calc. Replaces the mock-only `/inventory/recipes` page with live CRUD + per-ingredient cost from latest invoice prices.
**Schema:**
- `recipes(id, business_id, org_id, name, type, menu_price, portions, notes, archived_at, created_at, updated_at)`
- `recipe_ingredients(id, recipe_id, product_id FK, quantity, unit, notes, position)` — UNIQUE(recipe_id, product_id) (later replaced by M086 partials)
- updated_at trigger on recipes; ingredient changes bump parent updated_at
- RLS via `org_id = ANY(current_user_org_ids())` for both tables
**Cost model:** `food_cost = sum(qty × product.latest_price)`; `food_pct = food_cost/menu_price`; `gp_pct = (menu_price-food_cost)/menu_price`. MVP unit assumption: ingredient.unit == product.invoice_unit (superseded by M087 pack_size conversion).

### M083 — supplier_classifications ✅ applied 2026-05-23
**File:** `sql/M083-SUPPLIER-CLASSIFICATIONS.sql`
**Purpose:** Per-business override for the matcher's gate-0 classifier. Owner clicks "Skip ALL from supplier" on `/inventory/review` → row inserted here. Matcher checks this table BEFORE the universal supplier-name classifier, so future invoices from the same supplier auto-skip without manual triage.
**Schema:** `supplier_classifications(id, business_id, supplier_fortnox_number, supplier_name_snapshot, classification CHECK IN ('not_inventory'), classified_at, classified_by)`. UNIQUE(business_id, supplier_fortnox_number) — full constraint. RLS via business_id IN orgs.
**Companion code:** `/api/inventory/needs-review/skip-supplier` POST + the new `/api/inventory/skipped-suppliers` admin endpoints + `/inventory/skipped` page.

### M082 — invoice_pdf_extractions.extracted_rows_json ✅ applied 2026-05-21
**File:** `sql/M082-INVOICE-PDF-EXTRACTIONS-ROWS.sql`
**Purpose:** Persist Claude's raw extracted rows on the PDF extraction row, so the Phase B.4 review UI can show + edit rows that hit validation. Single JSONB column.
**Schema:** `invoice_pdf_extractions.extracted_rows_json JSONB` (nullable).

### M080 — fortnox_vouchers_cache ⏳ pending application
**File:** `sql/M080-FORTNOX-VOUCHERS-CACHE.sql`
**Purpose:** Local cache of Fortnox voucher data so /api/revisor/vouchers (R3 verifikationslista) and /api/revisor/sie (R2 SIE export) don't pay the 90-120s Fortnox API round-trip on every page load. First fetch of a month still slow; subsequent reads <50ms. Closed periods cached indefinitely; current + previous month refreshed by daily cron (separate commit).
**Schema:**
- One row per Fortnox voucher, keyed UNIQUE (business_id, period_year, voucher_series, voucher_number)
- Header columns: transaction_date, description, reference_number/type, comments, fortnox_year
- rows JSONB stores the full FortnoxVoucherRow[] array with all per-row fields
- Aggregates: rows_count, debit_total, credit_total (pre-computed for grand-totals queries)
- Indexes: (business_id, period_year, period_month, transaction_date) for primary read path; GIN on rows for "find vouchers touching account N" future queries; (business_id, period_year, period_month, fetched_at DESC) for freshness checks
- RLS via current_user_org_ids() (same M018 pattern)
**Companion code:**
- `lib/fortnox/voucher-cache.ts` — `getCachedVouchersForRange()` wrapper around fetchVouchersForRange. Reads cache per-month; if any month is missing, fetches its full range from Fortnox + writes back. ?refresh=1 query param force-evicts the range before re-fetching.
- /api/revisor/vouchers + /api/revisor/sie both swapped to the cached fetcher
- X-Voucher-Source / X-Voucher-Cache-Hits / X-Voucher-Cache-Miss / X-Voucher-Duration response headers on the vouchers endpoint for observability
**Idempotent.**

### M079 — businesses.legal_name + legal_city ⏳ pending application
**File:** `sql/M079-BUSINESSES-LEGAL-NAME.sql`
**Purpose:** Distinguish legal entity name (e.g. "Aglianico i Örebro AB" from Fortnox) from owner-set display/trading name (e.g. "Chicce Slotsgatan"). Both are correct; they answer different questions. Per BFL 7 kap. the LEGAL entity name MUST appear on archival print-outs. Adds two nullable TEXT columns.
**Companion code:**
- `lib/fortnox/company-identity.ts` revised policy:
  · legal_name: Fortnox always wins (auto-populated; alert only if Fortnox now disagrees with a previously-set legal_name — re-OAuth-to-wrong-company case)
  · name: owner-controlled display name; never overwritten by Fortnox after initial backfill; not_alerted on dual-identity case
  · legal_city / city: same shape
- `/revisor/[bizId]/[year]/[month]` uses `legal_name ?? name` as the print/compliance entity name; shows trading name as a parenthetical when different.
- `/api/revisor/data` returns legal_name + legal_city.
**Idempotent.** ALTER TABLE … ADD COLUMN IF NOT EXISTS.

### M078 — Invoice PDF extractions (Path B) ⏳ pending application
**File:** `sql/M078-INVOICE-PDF-EXTRACTIONS.sql`
**Purpose:** Path B of inventory catalogue (INVENTORY-PATH-B-PDF-EXTRACTION.md). Chicce's first backfill returned 3218/3218 rows with `raw_description=''` because Fortnox doesn't post per-line product data for invoices booked as single-line payables. Path B parses the attached PDFs via Claude Sonnet 4.6 vision + tool use, validates against the Fortnox header total (±2%), and replaces placeholder rows atomically.
**Schema:**
- `invoice_pdf_extractions` — per-invoice job + audit (status enum: pending/extracting/extracted/failed/no_pdf/needs_review, attempts, rows_extracted, total_extracted vs total_header, validation_warnings JSONB, cost telemetry tokens_in/out + cost_usd)
- `supplier_invoice_lines.source` — new column tagging row provenance (fortnox_row / pdf_extraction / owner_correction)
- `apply_invoice_pdf_extraction(...)` RPC — atomic DELETE-then-INSERT inside one transaction so re-extracting an invoice safely replaces placeholders
**Companion code:**
- `lib/inventory/pdf-extractor.ts` — Fortnox file fetch → Sonnet 4.6 vision call (record_invoice_rows tool) → validators (total-match ±2%, VAT presence, description non-empty) → RPC persistence. Cost ~$0.02-0.04 per invoice.
- `lib/inventory/pdf-extraction-worker.ts` — finds invoices needing extraction (empty description + has PDF + not terminal), batches at 40 per call, auto-chains via waitUntil up to 16 batches (~600 invoices/run).
- `app/api/inventory/lines/extract-pdfs` — kick endpoint (background-worker pattern, maxDuration=800s).
- `/admin/v2/tools` — `✦ Extract PDFs (Path B)` button + PDF-phase progress card (Extracted ✓ / Needs review / Failed / No PDF / Rows persisted / Cost USD / Batch size / Remaining).
**Idempotent.** Re-running on a business is safe — terminal states (extracted/needs_review/no_pdf/failed≥3 attempts) are skipped.

### M077 — Reviews summary persistence + reply tracking ⏳ pending application
**File:** `sql/M077-REVIEWS-SUMMARY-AND-REPLIES.sql`
**Purpose:** Two gaps from M074:
1. Google Places returns total review count (`userRatingCount`) + overall rating in the same payload as the per-review rows, but `lib/reviews/sync.ts` only stored the rows — the summary was thrown away. Result: a business with 278 reviews on Google showed "5 reviews" on the page (Places API caps content at the 5 most recent). Adds 3 columns on `businesses`: `google_review_count`, `google_overall_rating`, `google_last_sync_at`.
2. The original `/reviews` design calls for `replied / needs-reply / avg-response` KPIs. Adds 3 columns on `review_themes`: `replied_at`, `reply_text`, `reply_tone`. Owner manually marks each review as replied via a "Mark replied" button (until Google Business Profile OAuth lands and we can detect replies automatically).
**Companion code:**
- `lib/reviews/sync.ts` persists the summary every sync.
- `/api/reviews/summary` — new endpoint returning the 4 spec KPIs (rating · replied · needs-reply · avg-response) + the real Google total.
- `/api/reviews/draft-reply` — Haiku-4.5 AI reply drafter. Tones: warm / professional / apologetic. Subject to the per-org daily AI quota.
- `/api/reviews/mark-replied` — toggle replied_at on a review (`undo:true` clears).
- `/api/reviews/list` extended with reply state (replied_at / reply_text / reply_tone).
- `/reviews` page surgically updated: new SummaryStrip with spec-aligned KPIs, `GoogleApiLimitCallout` explaining the 5-vs-278 gap, AI-reply popover per review card (tone toggle, regenerate, edit, copy, mark-as-replied), visual replied/needs-reply state on each card.
**Idempotent.** All ALTERs are IF NOT EXISTS.

### M076 — Inventory backfill state ⏳ pending application
**File:** `sql/M076-INVENTORY-BACKFILL-STATE.sql`
**Purpose:** Phase A follow-up. The original /api/inventory/lines/backfill ran synchronously and timed out (HTTP 504) on businesses with >~60 invoices. Adds `inventory_backfill_state` table so the kick endpoint can write progress, fire a `waitUntil` background worker, and return instantly while the admin UI polls for live counts. Same pattern as `fortnox_backfill_state`. One row per business via UNIQUE(business_id); kicks UPSERT.
**Companion code:**
- `lib/inventory/backfill-worker.ts` — extracted 12-month walk + matcher loop, writes progress every 5 invoices.
- `app/api/inventory/lines/backfill` rewritten as a thin kick (fires worker via `@vercel/functions.waitUntil`, returns 200 immediately).
- `app/api/inventory/lines/backfill/status` — read-side companion for polling.
- `/admin/v2/tools` — Kick button now non-blocking, with live progress card (phase label, invoice-progress bar, 6-tile counter grid, recent-errors collapsible).

### M075 — Inventory catalogue (Phase A) ⏳ pending application
**File:** `sql/M075-INVENTORY-CATALOGUE.sql`
**Purpose:** Phase A of INVENTORY-CATALOGUE-PLAN.md. Adds three tables (`products`, `product_aliases`, `supplier_invoice_lines`) + pg_trgm extension + RLS policies + two helper RPCs (`inventory_trigram_search`, `inventory_touch_alias`). The two unique indexes on `product_aliases` (`(business_id, supplier_fortnox_number, article_number)` partial + `(business_id, supplier_fortnox_number, normalised_description, COALESCE(unit, ''))` partial) are the load-bearing dedup constraints — one product = one row, structurally.
**Deviation from plan:** no local `suppliers` cache table; Fortnox `SupplierNumber` stored as TEXT directly on each row, with denormalised `supplier_name_snapshot` for display.
**Companion code:**
- `lib/inventory/normalise.ts` — bedrock normalisation function (lowercase, åäö→aao, strip punctuation, collapse unit-suffix spacing)
- `lib/inventory/categories.ts` — BAS account → inventory category routing (4010/4011/4012/4015/4017/4018/5410/5460 → food/alcohol/beverage/disposables/takeaway_material/cleaning)
- `lib/inventory/matcher.ts` — 5-step matching ladder. Idempotent. Reads/writes via the two RPCs above.
- `app/api/inventory/lines/backfill` — owner-triggered 12-month backfill endpoint.
- `app/api/cron/inventory-lines-sync` — daily 06:30 UTC incremental for businesses with ≥1 row in supplier_invoice_lines. 48h lookback.
**Idempotent.** Re-runs are no-ops via ON CONFLICT.

### M068 — Add Örebro to school_holidays seed + set Chicce's kommun ⏳ pending application
**File:** `sql/M068-SCHOOL-HOLIDAYS-OREBRO-SEED.sql`
**Purpose:** Chicce Slotsgatan is in Örebro (kommun 1880, län 18) which wasn't in the M067 seed. Extends seed coverage with 10 holiday rows for Örebro 2025-2027 + sets `businesses.kommun='1880'` for Chicce. Without this, the school_holiday signal returns null for Chicce → factor stays neutral 1.0 → no school-holiday signal contribution to her forecasts. Idempotent.

### M067 — Swedish school holidays seed (Piece 3) ⏳ pending application
**File:** `sql/M067-SCHOOL-HOLIDAYS-SE-SEED.sql`
**Purpose:** populate the M056 `school_holidays` table with manual data for Sweden's largest kommuns (Stockholm 0180, Göteborg 1480, Malmö 1280, Uppsala 0380) covering 2025-2027 across all five restaurant-relevant break types (höstlov / jullov / sportlov / påsklov / sommarlov). Skolverket doesn't publish a uniformly-machine-readable per-kommun calendar, so the seed is hand-curated. Idempotent (UNIQUE constraint + ON CONFLICT DO NOTHING).
**Companion code:**
- `lib/forecast/school-holidays.ts` — `getActiveSchoolHoliday()` lookup
- `lib/forecast/daily.ts` — Piece 3 wiring: school_holiday signal now reads real data, klamdag uses prior-occurrence median, yoy_same_weekday activates at 365+ days history, weather_change_vs_seasonal uses 3 prior years' same-week temperatures
- model_version bumped to `consolidated_v1.1.0`
**Architecture:** PIECE-3-IMPLEMENTATION-PROMPT.md Stream A.

### M065 — Forecast MAPE comparison view (Piece 2) ⏳ pending application
**File:** `sql/M065-FORECAST-MAPE-VIEW.sql`
**Purpose:** `v_forecast_mape_by_surface` view aggregating MAPE / bias / sample counts by `(business_id, surface, prediction_horizon_days)` from `daily_forecast_outcomes` resolved rows. Powers Phase A acceptance gate for Piece 2 — side-by-side comparison of consolidated_daily vs the two legacy surfaces. Phase B cutover criterion: consolidated within 2pp of better legacy AND no horizon shows >20% divergence.
**Companion code:** `app/api/admin/forecast-mape/route.ts` exposes the view as JSON (admin-authed). Pairs with the Vero backfill script `scripts/backfill-vero-consolidated-forecasts.ts` which populates 145+ retrospective rows for instant Phase A signal instead of waiting two weeks of shadow capture.
**Companion architecture:** Piece 2 implementation prompt at `PIECE-2-IMPLEMENTATION-PROMPT.md`. Idempotent CREATE OR REPLACE.

### M064 — Extend integrations.status CHECK constraint ⏳ pending application
**File:** `sql/M064-INTEGRATIONS-STATUS-CONSTRAINT.sql`
**Purpose:** same pattern as M061 (paused) and M063 (plan values). The TypeScript union for `integrations.status` includes `disconnected`, `needs_reauth`, `pending` etc. but the DB CHECK constraint only allowed the original handful. The new `/api/integrations/disconnect` endpoint failed on first use with `integrations_status_canonical_chk` violation when setting `status='disconnected'`. Fourth instance of constraint drift in 24h — see `feedback_check_constraint_drift` memory.

### M063 — Extend organisations.plan CHECK constraint ⏳ pending application
**File:** `sql/M063-ORGANISATIONS-PLAN-CONSTRAINT.sql`
**Purpose:** the 2026-04-23 pricing overhaul (`project_pricing_2026_04` memory) added four new plan values — `founding`, `solo`, `group`, `chain` — to `lib/stripe/config.ts`'s PLANS map and to every UI surface, but the DB CHECK constraint still enumerated the old set (trial / starter / pro / enterprise / past_due). Any admin UPDATE setting a new plan value failed with `organisations_plan_check` violation. Drops + re-creates the constraint with all current values. Idempotent.
**Companion code:** none — code already uses the new values; this just unblocks them at the DB level.

### M062 — tracker_data.is_provisional flag ⏳ pending application
**File:** `sql/M062-TRACKER-IS-PROVISIONAL.sql`
**Purpose:** marks tracker_data rows whose books aren't closed yet (current calendar month + prior month before the 15th — the typical Swedish accountant closure window). Without the flag, partial-month data corrupts trend lines and AI prompts: April 2026 showing revenue=85k vs April 2025=625k looks like a 86% revenue collapse when reality is just "books still open."
**Schema:** `is_provisional BOOLEAN NOT NULL DEFAULT FALSE` plus a partial index on `(business_id, period_year, period_month) WHERE is_provisional = TRUE` for cheap inverse-filter queries.
**Backfill at apply time:** the migration UPDATEs any existing rows in the current/prior-month-before-15th period to flag them.
**Companion code:**
- `lib/finance/period-closure.ts` — `isProvisional(year, month, now?)` heuristic. Stockholm-time anchored.
- `app/api/cron/fortnox-backfill-worker/route.ts` — sets the flag on every tracker_data write.
- `lib/sync/aggregate.ts` — filters provisional rows out of the monthly_metrics roll-up so downstream consumers (memo, scheduling AI, dashboards) see only closed P&L.
- `app/api/forecast/route.ts` — same filter on the forecast baseline.
- `app/api/budgets/generate/route.ts` — same filter on YTD trajectory anchor (avoids "this year is collapsing!" hallucinations from the budget AI).
**Not filtered (intentional):** `app/api/tracker/route.ts`, `app/api/budgets/analyse/route.ts`, `app/api/budgets/route.ts` — these surface specific selected periods to the user. If they pick April 2026 explicitly, they want to see what's there.
**Architecture note:** companion to the API-priority strategy (`project_api_priority_strategy` memory). Phase D' — partial-data tagging.

### M061 — Add 'paused' to backfill_status CHECK constraint ⏳ pending application
**File:** `sql/M061-BACKFILL-STATUS-PAUSED.sql`
**Purpose:** companion to M060 — the resumable worker uses a new `backfill_status='paused'` value to signal "state saved, ready to resume". The original M050 CHECK constraint enumerated only `idle/pending/running/completed/failed`, so any UPDATE setting `'paused'` failed with `integrations_backfill_status_chk` violation. This migration drops + re-creates the constraint to include `'paused'`.
**Apply order:** AFTER M060 (M060 doesn't actually use the value at table-definition time, but the resume admin endpoint hits the constraint). Idempotent.

### M060 — Fortnox backfill resumability state ⏳ pending application
**File:** `sql/M060-FORTNOX-BACKFILL-STATE.sql`
**Purpose:** new `fortnox_backfill_state` table — persists work-in-progress so the backfill worker can checkpoint before the Vercel function timeout (600-800s) kills it. Without this, any backfill of >~10 minutes (Vero alone has ~17 minutes of work for 12 months) dies mid-flight with the row stuck at `running`.
**Schema:**
- `integration_id UUID PRIMARY KEY` — one state row per integration
- `voucher_queue JSONB` — full list of voucher summaries with fiscal-year context (built once during Phase 1; ~5KB per summary, 3,800 summaries ≈ 19MB JSONB row for Vero — acceptable, will revisit if needed)
- `cursor INTEGER` — index into voucher_queue of next summary to fetch
- `written_periods JSONB` — array of "YYYY-MM" strings already written to tracker_data
- `from_date / to_date` — range bounds for diagnostics
- `started_at / last_progress_at / resume_count` — telemetry
**Lifecycle:** created when worker enters Phase 1 (fresh start); updated after every period flush; deleted on `completed` or `failed`.
**Companion code:**
- `lib/fortnox/api/vouchers.ts` — split into `fetchVoucherSummariesForRange()` (Phase 0+1) + `fetchVoucherDetailsForSummaries()` (Phase 2 with `deadlineMs` for early exit). `fetchVouchersForRange()` retained as orchestrator for diagnose endpoint.
- `app/api/cron/fortnox-backfill-worker/route.ts` — full rewrite for resumability. Claims `pending` OR `paused`. Loads state row on resume; otherwise fetches summaries. Per-period flush after each period's summaries are exhausted. Time-budget gate at `maxDuration - 60s`; on hit, persists state, sets `backfill_status='paused'`, chains next worker via `waitUntil(triggerNext())`. New `backfill_progress.phase` values: `'listing'`, `'paused'`, `'resuming'`. New `backfill_status` value: `'paused'`.
- `app/api/admin/fortnox/kick-backfill/route.ts` — clears state row before flipping to `pending` (admin "kick" is fresh-start intent).
- `app/admin/v2/tools/page.tsx` — polling continues through `paused` state (only `completed`/`failed` are terminal); 60-min poll ceiling for multi-run chains.
**Apply order:** M060 must apply before the worker code deploys, else `fortnox_backfill_state` references throw 42P01.
**Architecture note:** see `project_api_priority_strategy` memory — this is Phase C of the API-priority strategy (Phase A = validators inherited from PDF apply; Phase B = skip-PDF rule inverted; **Phase C = resumability** unblocks multi-year backfills). Phase D = re-extract Vero's existing PDF months. Phase E = onboarding flow without PDF requirement.

### M059 — Daily forecast outcomes audit ledger (Piece 1) ⏳ pending application
**File:** `sql/M059-DAILY-FORECAST-OUTCOMES.sql`
**Purpose:** new `daily_forecast_outcomes` table — the audit ledger for every revenue prediction the two legacy forecasters (`/api/scheduling/ai-suggestion`, `lib/weather/demand.ts`) emit, plus future surfaces (`consolidated_daily`, `llm_adjusted`). Captured row carries `predicted_revenue`, `inputs_snapshot` (the exact signals the model used), `model_version`, `snapshot_version`, `prediction_horizon_days` (generated column = `forecast_date - first_predicted_at::date`). UNIQUE `(business_id, forecast_date, surface)` makes capture idempotent — re-firing the dashboard 5x produces one row per (business, date, surface) with the latest prediction winning. RLS read policy via `organisation_members` matches M020 / M053 / M057 verbatim. Retention RPC `prune_daily_forecast_outcomes()` mirrors the M020 3-year sweep.
**Companion code (in same commit):**
  - `lib/forecast/audit.ts` — `captureForecastOutcome()` / `captureForecastOutcomes()` helpers with backtest write guard (skips `forecast_date < today` unless `backfillMode: true`) and soft-fail on errors so audit logging never breaks the parent forecast response.
  - `app/api/scheduling/ai-suggestion/route.ts` — Phase A "shadow mode" capture; logs every `suggested[]` entry with `surface='scheduling_ai_revenue'`, `snapshot_version='legacy_v1'` carrying weekday + weather_bucket + this_week_scaler + bucket_days_seen.
  - `lib/weather/demand.ts` — same capture pattern in `computeDemandForecast()`; logs every non-holiday `out[]` entry with `surface='weather_demand'`. Confidence enum `'unavailable'` collapses to `null` per the table's CHECK (high|medium|low).
  - `app/api/cron/daily-forecast-reconciler/route.ts` — daily cron at 10:00 UTC. Walks pending rows, pairs against `daily_metrics.revenue`, applies the four resolution paths (defer < 7d / unresolvable_no_actual ≥ 7d / unresolvable_data_quality on confirmed anomaly / unresolvable_zero_actual on closed days / resolved with `error_pct = (predicted - actual) / actual`). Anomaly contamination filter: `alert_type IN ('revenue_drop','revenue_spike') AND confirmation_status = 'confirmed'`. Calls `prune_daily_forecast_outcomes()` at the end.
  - `vercel.json` — adds `/api/cron/daily-forecast-reconciler` at `0 10 * * *`. Slot picked because the post-Piece-0 stagger occupies 04:00-09:30 and `today-data-sentinel` is at 14:00; 10:00 is clean. Architecture v3 §5 originally proposed 07:30 but that's now `onboarding-success`.
**Apply order:** M059 must apply before the code deploys, else the cron fires and sees an undefined table. Idempotent — safe to re-run.
**Phase A intent:** capture only. No behaviour change to either forecaster's response. Pieces 2-5 build on the ledger to ship the consolidated forecaster + new signals + LLM adjustment.

### M058 — Vero OB-supplement step-change auto-resolve backfill ⏳ pending application
**File:** `sql/M058-VERO-OB-AUTO-RESOLVE-BACKFILL.sql`
**Purpose:** one-shot WHERE-IN-(business_id, alert_type) CLEANUP. After M053 + the detector's step-change patch in `lib/alerts/detector.ts` shipped, Vero's existing 14 pending alerts include multiple duplicates of the same OB-supplement step-change pattern. This SQL keeps the EARLIEST alert per (business_id, alert_type) group as `pending` (so the operator can triage one) and flips the rest to `auto_resolved` with an explanatory note. Idempotent — re-running finds no rows to update.
**Pre-requisite:** M053 must already be applied so `confirmation_status` exists.
**Run after:** M053 applied.
**Companion:** Stream D's detector patch ensures future step-change continuations auto-resolve at write time, so this backfill is a one-time clean-up — not a recurring need.

### M052-M057 — Piece 0 of prediction system v3.1 ⏳ pending application
**Files (in apply order — all idempotent):**
1. `sql/M052-TRACKER-CREATED-VIA-BACKFILL.sql` — UPDATE-only; backfills the ~21 NULL `tracker_data.created_via` rows to `'manual_pre_m047'`. Run this first; it has no schema dependencies.
2. `sql/M053-ANOMALY-CONFIRMATION-WORKFLOW.sql` — adds `confirmation_status`, `confirmed_at`, `confirmed_by`, `confirmation_notes` to `anomaly_alerts` + partial index. Defaults all existing rows to `'pending'`.
3. `sql/M054-BUSINESS-CLUSTER-COLUMNS.sql` — adds `cuisine`, `location_segment`, `size_segment`, `kommun` to `businesses`. UPDATEs both Vero rows with manual values: Vero Italiano = (italian, city_center, medium, 0180); Rosali Deli = (deli, city_center, small, 0180).
4. `sql/M055-BUSINESS-CLUSTER-MEMBERSHIP.sql` — new join table for many-to-many cluster mapping. DDL only; no data.
5. `sql/M056-SCHOOL-HOLIDAYS.sql` — new table for kommun-level school holidays. DDL only; Skolverket scraper lands in Piece 3 batch 2.
6. `sql/M057-BUSINESS-FEATURE-FLAGS.sql` — new per-business flag table parallel to existing `feature_flags`. Defaults `enabled=false`. RLS service-role-only writes, member-read.

**Architecture context:** all six are Piece 0 of the prediction-system rebuild. v3.1 decision log at `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` Appendix Z. Companion code already merged in the same commit:
- `app/api/admin/weather/backfill/route.ts` — accepts `start_date` query param for ≥3yr historical fetch
- `app/api/cron/ai-accuracy-reconciler/route.ts` — also writes `forecast_calibration.accuracy_pct`/`bias_factor` (replacing the deprecated calibration cron)
- `vercel.json` — `/api/cron/forecast-calibration` removed
- `app/api/cron/forecast-calibration/route.ts` — deprecation header added; route file kept in tree

**Run order:** safe to run all six in sequence in Supabase SQL Editor. Each is idempotent. After applying, hit `POST /api/admin/weather/backfill?secret=...&start_date=2023-05-01` once to populate ~3 years of `weather_daily` for both Vero businesses.

**What still needs Piece 0 (deferred to next session):**
- Stream D — `/api/alerts` PATCH `confirm`/`reject` actions + `/alerts` page UI buttons + OB step-change detector tuning + Vero anomaly triage call
- Stream F.2 — `lib/featureFlags/prediction-v2.ts` wrapper querying `business_feature_flags`
- Stream E — `docs/operations/vero-anomaly-triage-runbook.md`

### M051 — Overhead drilldown cache table ✅ applied 2026-05-07 (direct SQL)
**File:** `sql/M051-OVERHEAD-DRILLDOWN-CACHE.sql`
**Purpose:** five-minute cache for owner-facing drill-down on overhead-review flag cards. The new endpoint `/api/integrations/fortnox/drilldown` writes payloads here keyed by `(business_id, period_year, period_month, category)` so multiple supplier flags in the same category+month share one Fortnox fetch. Client filters to the requested supplier on render.
**Note:** Paul applied the table directly via Supabase SQL editor on 2026-05-07 before the migration file was written; this file is idempotent (`CREATE TABLE IF NOT EXISTS`) so re-running for documentation/audit-trail purposes is safe. Includes RLS policy for service-role-only access.

### M050 — Fortnox API backfill state columns on `integrations` ⏳ pending application
**File:** `sql/M050-FORTNOX-BACKFILL-COLUMNS.sql`
**Purpose:** state machine for the 12-month Fortnox API backfill triggered after OAuth connect. Adds `backfill_status` (NULL / `idle` / `pending` / `running` / `completed` / `failed`), `backfill_started_at`, `backfill_finished_at`, `backfill_progress JSONB`, `backfill_error TEXT` to `integrations`. CHECK constraint guards the enum. Partial index `idx_integrations_backfill_pending` for cheap "find next pending" claim queries.
**Companion code:**
  - `app/api/cron/fortnox-backfill-worker/route.ts` — drains pending Fortnox integrations: claims atomically, fetches 12 months of vouchers via `lib/fortnox/api/vouchers.ts`, translates via `lib/fortnox/api/voucher-to-aggregator.ts`, projects via `projectRollup`, writes `tracker_data` rows with `source='fortnox_api'` and `created_via='fortnox_backfill'`. Idempotency check skips months that PDF apply has already populated (`source IN ('fortnox_pdf', 'fortnox_apply')`).
  - OAuth callback now sets `backfill_status='pending'` as part of the upsert (instead of the old current-month-only `syncFortnoxInBackground`) and fires the worker via fire-and-forget HTTP POST.
  - Daily cron `/api/cron/fortnox-backfill-worker` at 07:00 UTC as a backstop in case the immediate fire-and-forget didn't reach the worker.
**Order of operations:** apply M050 in Supabase before the matching code deploys, otherwise the OAuth callback's upsert will fail with `42703` (column does not exist) on the new `backfill_*` columns.

### M049 — Non-partial unique index for Fortnox OAuth upsert ⏳ pending application
**File:** `sql/M049-INTEGRATIONS-OAUTH-UPSERT-KEY.sql`
**Purpose:** the OAuth callback upsert at `app/api/integrations/fortnox/route.ts` was failing with `42P10` because every existing unique enforcement on `integrations` is via partial indexes (`WHERE department IS NULL`, `WHERE business_id IS NOT NULL`, expression-based `COALESCE(department, '')`), and PostgREST's `?onConflict=col1,col2` only matches non-partial unique constraints/indexes by column list. Adds a non-partial `UNIQUE (org_id, business_id, provider)` so the upsert (with onConflict updated to that key in the matching code commit) can land. The new index is functionally redundant with the existing `integrations_org_biz_provider_dept_unique` partial for the `business_id IS NOT NULL` case — it just exposes the same constraint to PostgREST in a shape it can use.
**Pre-flight:** the migration runs a `DO $$ ... EXCEPTION` block that aborts with a clear error if any duplicate `(org_id, business_id, provider)` rows exist in `integrations`. Production has zero Fortnox rows so a duplicate is unlikely, but the guard is there in case any pre-existing PK / Caspeco / Onslip data violates the new shape.
**Caveat:** still does not dedupe rows where `business_id IS NULL` (Postgres treats NULL as distinct under standard UNIQUE). Those are covered by the existing `integrations_org_null_biz_provider_unique` partial. New OAuth callbacks always carry a non-null business_id thanks to the page-button guard (`disabled={!selectedBiz}`, commit 66ffb5b), so this gap doesn't affect the OAuth path. Admin concierge tokens that omit business_id can still produce NULL — separate follow-up.
**Companion code:** matching commit changes `onConflict: 'business_id,provider'` to `onConflict: 'org_id,business_id,provider'` in `app/api/integrations/fortnox/route.ts`.
**Order of operations:** apply M049 in Supabase BEFORE Vercel deploys the matching code — otherwise the upsert will continue failing with the new column list. (Or apply concurrently — either order works once both are live.)

### M048 — Fortnox API verification harness mirror tables ⏳ pending application
**File:** `sql/M048-VERIFICATION-TABLES.sql`
**Purpose:** Phase 1 of the Fortnox API backfill plan. Creates `verification_*` mirror tables (cloned from `tracker_data`, `tracker_line_items`, `monthly_metrics`, `daily_metrics`, `dept_metrics`, `revenue_logs`, `financial_logs` via `LIKE INCLUDING ALL`) plus `verification_runs` for run metadata. The harness writes API-derived metrics into the mirrors so they can be diff'd against PDF-derived production data without touching production rows.
**Notes:**
  - Verification harness only. Safe to drop after Phase 1 completes — drop script is at the bottom of the SQL file.
  - The Phase 1 prompt named `vat_breakdown` in the mirror list; that table does NOT exist (VAT split lives as columns on `tracker_data` per M029). Skipped.
  - `tracker_line_items` was not in the prompt's list but was added so material-drift root-causing has line-level data to walk back through.
  - No new application code reads these tables. They are visible only to the verification harness and the report generator.
**Scripts that depend on this:** `scripts/verification-runner.ts`, `scripts/verification-report.ts`. Both will refuse to run until the migration is applied.

---

## Recently applied — for reference

### M047 — Fortnox apply guardrails (sha256 + CHECK + created_via) ✅ applied 2026-05-03
**File:** `M047-FORTNOX-GUARDRAILS.sql` (repo root)
**Purpose:** defence-in-depth for the Fortnox PDF apply pipeline. Three additions:
  - `fortnox_uploads.pdf_sha256 TEXT` + index `(business_id, pdf_sha256) WHERE pdf_sha256 IS NOT NULL`. Computed at upload time; the upload route short-circuits with status='duplicate' on a hit so an accidental re-upload of the same PDF doesn't pile up.
  - CHECK constraints on `tracker_data`: revenue / food_cost / staff_cost / alcohol_cost / other_cost ≥ 0; period_month in [0..12]; period_year in [2000..2099]. Even if the application code skips a validator, the DB rejects impossible values.
  - `tracker_data.created_via TEXT` (nullable) — origin tag. New code paths populate explicitly: `'fortnox_apply'` for the Fortnox pipeline. The new daily cron `/api/cron/manual-tracker-audit` uses an index on `(business_id, created_at DESC) WHERE created_via IS NULL AND fortnox_upload_id IS NULL` to find rogue manual writes (the Rosali March 2026 case).
**Companion code:**
  - `lib/fortnox/validators.ts` — single chokepoint, 10 rule-based checks (org-nr match, period match, scale anomaly, sign convention, math consistency, doc-type vs claimed, period gap, subset caps, etc.).
  - `lib/fortnox/ai-auditor.ts` — Haiku second-opinion call returning {confidence, summary, concerns}; fail-tolerant, never blocks apply.
  - `app/api/fortnox/apply/route.ts` — runs validators + auditor before any tracker_data write. Returns 422 with `validation_blocked` when blocking errors or unacknowledged warnings present. UI passes `acknowledged_warnings: string[]` to proceed past warnings, `force: true` for overridable errors.
  - `app/api/fortnox/upload/route.ts` — SHA-256 fingerprint + duplicate check.
  - `app/api/cron/manual-tracker-audit` — daily 06:45 UTC ops email when suspicious manual rows appear.
**Backwards compat:** all ADD COLUMN are nullable / IF NOT EXISTS; CHECK constraints guarded against re-application; index uses `IF NOT EXISTS`. Wrapped in transaction. Verify queries at the bottom dump the new column + constraint list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M046 — Onboarding expansion (opening_days + business_stage) ✅ applied 2026-05-02
**File:** `M046-ONBOARDING-EXPANSION.sql` (repo root)
**Purpose:** Onboarding now collects business address, organisationsnummer, business stage, opening days, and an optional last-year P&L PDF upfront — see app/onboarding/page.tsx. The DB needs two new columns on `businesses` to store the structured data the wizard captures.
  - `businesses.opening_days   JSONB DEFAULT '{"mon":..,"sun":true}'` — drives scheduling AI (no labour-cut suggestions on closed days) and the /scheduling weekly grid. Column default keeps legacy rows rendering sensibly until owners update.
  - `businesses.business_stage TEXT` with CHECK in (`new`, `established_1y`, `established_3y`). Drives budget AI: 'new' skips the historical-anchor rule (no last-year actuals exist), 'established_*' enforces it. NULL allowed for backfill safety.
**Companion code:**
  - `app/api/businesses/add/route.ts` — accepts `address`, `opening_days`, `business_stage`, validates the enum + JSON shape at the API edge.
  - `app/api/onboarding/complete/route.ts` — accepts `org_number`, writes to `organisations.org_number` via the new shared helper `lib/sweden/applyOrgNumber.ts` (also handles Stripe metadata + tax_id sync). Same helper now backs `/api/settings/company-info` POST so the two paths can't drift.
  - `components/OrgNumberBanner.tsx` and `components/OrgNumberGate.tsx` DELETED — onboarding now requires org_number upfront, the 30-day grace banner + lockout are dead. `misc.orgGate` and `settings.orgNumberBanner` keys removed from all 3 locale JSONs.
**Backwards compat:** pure additions, defaults sensible, `IF NOT EXISTS` on each column, CHECK constraint guarded by an `information_schema` lookup so re-runs are safe. Wrapped in a transaction.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verify query at the bottom dumps the resulting columns.

### M045 — sync_log indexes (kill the 91% seq-scan rate) ✅ applied 2026-04-30
**File:** `M045-SYNC-LOG-INDEXES.sql` (repo root)
**Purpose:** Supabase performance probe flagged `sync_log` doing 91% sequential scans (162 seq scans reading 60k tuples on a 1106-row table). Hot access patterns are `(org_id, created_at DESC)` (per-customer sync history) and `(status, created_at DESC) WHERE status != 'success'` (failure listings on the admin overview + agents tab). Two new indexes cover both. Partial index on the failure case keeps it small.
**Backwards compat:** indexes are pure additions; no data change. `IF NOT EXISTS` makes re-runs safe.
**Safety:** wrapped in `BEGIN; … COMMIT;`. Verify query at the bottom dumps the resulting index list.
**Footnote — duplicate index spotted on apply:** the verify output showed `sync_log_org_idx` already covered `(org_id, created_at DESC)` from a much earlier migration. My new `idx_sync_log_org_created` is therefore redundant with it. Harmless on a 1k-row table — both indexes get used interchangeably and the storage cost is negligible. Future cleanup: `DROP INDEX idx_sync_log_org_created` (keep the older `sync_log_org_idx` since older callers may reference it by name in EXPLAIN logs). The partial `idx_sync_log_status_created` is genuinely new and serves the failure-listing pattern that had no index before.

### M044 — Per-user locale preference (i18n PR 1)
**File:** `M044-USER-LOCALE.sql` (repo root)
**Purpose:** part of FIXES.md §0be. Adds `organisation_members.locale` (TEXT, default 'en-GB', CHECK in {`en-GB`, `sv`, `nb`}). Authenticated users persist their language pick on the membership row so it survives across devices and sessions. Anonymous visitors are cookie-only until they sign up — at which point the cookie value migrates into this column.
**Backwards compat:** every existing member gets `locale='en-GB'` (the current default behaviour). The selector lets them flip; pre-i18n-rollout the value was unused so no semantic change.
**Safety:** `ADD COLUMN IF NOT EXISTS`, idempotent CHECK. Wrapped in `BEGIN; … COMMIT;`.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M043 — Member roles + scoping (manager access)
**File:** `M043-MEMBER-ROLES-AND-SCOPING.sql` (repo root)
**Purpose:** part of FIXES.md §0az. Adds the columns + CHECK constraint that back the new manager role for customer staff. Existing rows keep `role='owner'` so no behaviour change for current users.
  - `organisation_members.role` — pre-existing column. Coerced to `'owner'` for any null/legacy values, then CHECK-constrained to `('owner', 'manager', 'viewer')`.
  - `organisation_members.business_ids UUID[]` — null = all businesses in the org (single-restaurant case + unscoped manager); array = limited to those businesses. Server-side filter applies on every business-scoped API.
  - `organisation_members.can_view_finances BOOLEAN DEFAULT FALSE` — escape hatch for finance-trusted managers. False by default; managers don't see /tracker, /budget, /forecast, /overheads unless this is flipped.
  - `organisation_members.invited_by`, `invited_at`, `last_active_at` — provisioning audit trail.
  - Index `(org_id, role)` for fast member-list queries on the admin v2 Users sub-tab.
**Backwards compat:** every pre-M043 user has `role='owner'`, `business_ids=NULL`, `can_view_finances=FALSE`. Owners ignore the flag (full access regardless). Managers don't exist yet so the new columns are inert until provisioned.
**Safety:** all `ADD COLUMN IF NOT EXISTS`. Rogue role values pre-coerced to `'owner'` so the CHECK never fails on existing data. Wrapped in `BEGIN; … COMMIT;`.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M042 — Swedish organisationsnummer on organisations + businesses
**File:** `M042-COMPANY-ORG-NUMBER.sql` (repo root)
**Purpose:** part of FIXES.md §0ax. Adds `org_number TEXT` to both `organisations` and `businesses` (10-digit format, CHECK-constrained `^[0-9]{10}$`). Required at signup going forward; existing customers get a 30-day grace tracked via `organisations.org_number_grace_started_at` (defaults to now() at migration time). `businesses.org_number` is optional — used when a customer runs multiple restaurants under separate ABs; falls back to the parent organisation's number otherwise. Two indexes for fast org-nr lookup from the command palette.
**Backwards compat:** all existing rows get `org_number = NULL` and a fresh `grace_started_at = now()`. Soft banner on the dashboard nudges them; hard-block fires after 30 days. New signups go through validation in `lib/sweden/orgnr.ts` (Luhn-style checksum) — invalid entries rejected by the API.
**Safety:** `ADD COLUMN IF NOT EXISTS`, idempotent CHECK, `IF NOT EXISTS` indexes. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end show column metadata + constraint definitions + the count of organisations missing org_number (the audience for the soft banner).
**To apply:** open Supabase SQL Editor, paste file contents, run.

---

## Recently applied — for reference

### M041 — Overhead review: extend to food costs (category column) ✅ applied 2026-04-28
**File:** `M041-OVERHEAD-FOOD-CATEGORY.sql` (repo root)
**Purpose:** part of FIXES.md §0av (food-cost extension of overhead-review). Adds `category TEXT NOT NULL DEFAULT 'other_cost'` to both `overhead_classifications` and `overhead_flags`, with `CHECK (category IN ('other_cost', 'food_cost'))`. Replaces the auto-named UNIQUE constraints with named ones that include category: `overhead_classifications_natural_key` on `(business_id, supplier_name_normalised, category)` and `overhead_flags_idempotency_key` on `(business_id, source_upload_id, supplier_name_normalised, flag_type, category)`. Adds two indexes for fast category filtering.
**Backwards compat:** existing rows default to category='other_cost'. The detection worker still works for callers that don't specify categories — `runOverheadReview()` defaults to scanning both. The decide and backfill endpoints upsert with explicit category. The flags GET surfaces `category` in the response.
**Safety:** `ADD COLUMN IF NOT EXISTS`, defensive constraint drops via DO block, idempotent CHECK adds. Wrapped in `BEGIN; … COMMIT;`. Verification queries dump column metadata + constraint definitions + (post-migration) the new natural keys.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M040 — Integration state log + canonical status vocabulary ✅ applied 2026-04-28
**File:** `M040-INTEGRATION-STATE-LOG.sql` (repo root)
**Purpose:** part of FIXES.md §0at (sync-state centralization). Two pieces in one migration:
  1. CHECK constraint on `integrations.status` enforcing the canonical vocabulary `('connected', 'needs_reauth', 'error', 'retired')`. Rogue rows are coerced to `'error'` before the constraint is added so the migration never fails on existing data.
  2. New `integration_state_log` table — append-only audit of every state transition with `(prev_status, new_status, prev_last_error, new_last_error, context jsonb)`. Three indexes: per-integration history, per-org cross-table scan, and a partial index on failure transitions for rapid "find every wedge in the last hour" queries.
**Backwards compat:** all existing code paths continue to work — direct UPDATEs are still allowed (the constraint just rejects garbage status values). The new `lib/integrations/state.ts` module is the recommended path for new code; existing callers migrate file-by-file.
**Safety:** wrapped in `BEGIN; … COMMIT;`. Constraint creation is idempotent (drops + re-adds). Pre-coerces invalid statuses before the CHECK adds. Verification queries at the bottom: index list + constraint definition + status distribution.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M039 — Overhead review system (PR 1: schema only)
**File:** `M039-OVERHEAD-REVIEW.sql` (repo root)
**Purpose:** part of FIXES.md §0an (Overhead Review feature PR 1 of 5). Two related tables:
  1. `overhead_classifications(org_id, business_id, supplier_name, supplier_name_normalised, status, decided_by, decided_at, reason, baseline_avg_sek, baseline_set_at, backfill)` — persistent decisions per supplier per business. status ∈ {`essential`, `dismissed`}. UNIQUE (business_id, supplier_name_normalised). `dismissed` = "I plan to cancel this" (forward-looking). `baseline_avg_sek` is snapshotted at decision time so the price-spike re-flag rule has a stable comparator.
  2. `overhead_flags(org_id, business_id, source_upload_id, line_item_id, supplier_name, supplier_name_normalised, flag_type, reason, amount_sek, prior_avg_sek, period_year, period_month, surfaced_at, resolution_status, resolved_at, resolved_by, defer_until, ai_explanation, ai_confidence)` — append-only history of what the worker flagged. UNIQUE (business_id, source_upload_id, supplier_name_normalised, flag_type) makes the worker idempotent. CASCADE on source_upload_id + line_item_id cleans up automatically when an upload is hard-deleted; supersede (status change, not delete) is handled app-side in /api/fortnox/apply (extending the existing supersede cleanup).
**Indexes:** `(business_id, supplier_name_normalised)` for the hot lookup, `(business_id, status) WHERE status='dismissed'` for projection, `(business_id, surfaced_at DESC) WHERE resolution_status='pending'` for the review queue, `(business_id, period_year, period_month)` for supersede cleanup, `(defer_until) WHERE resolution_status='deferred'` for the defer-snooze sweep.
**RLS:** both tables get the M018 pattern — SELECT policy `org_id = ANY(current_user_org_ids())`. No INSERT/UPDATE policies; the only write paths are the worker (PR 2, service-role) and the decide API (PR 3, service-role with `decided_by` recorded from the session).
**Backwards compat:** /api/overheads/flags + /api/overheads/projection (PR 1) degrade gracefully when M039 isn't applied — return empty + `table_missing: true` + a banner-friendly note rather than 500. Same shape as the migration-pending pattern used in M035/M036/M037/M038.
**Safety:** `CREATE TABLE IF NOT EXISTS`, indexes IF NOT EXISTS, `DROP POLICY IF EXISTS` before `CREATE POLICY`. CHECK constraints on status/flag_type/resolution_status keep bad data out. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end: relation sizes + index list + policy list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

---

## Applied — Sprint 1 + Admin v2 batch (2026-04-28)

### M038 — Admin v2 PR 10 (saved investigations + customer notes) ✅ applied 2026-04-28
**File:** `M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql` (repo root)
**Purpose:** part of FIXES.md §0ak (Admin Console Rebuild PR 10). Two related tables in one migration:
  1. `admin_notes(id, org_id, parent_id, body, created_by, created_at, updated_at, pinned, deleted_at)` — first-class threaded notes for the customer-detail Notes sub-tab. Notes used to live as `note_add` rows on `admin_audit_log.payload` which made editing/deleting/threading/pinning impossible. Index `(org_id, pinned DESC, created_at DESC) WHERE deleted_at IS NULL` is the hot path for the sub-tab list. Soft-delete keeps the row for compliance.
  2. `admin_saved_queries(id, label, query, notes, org_id, created_by, created_at, last_used_at, run_count)` — saved Tools-tab investigations. Optional `org_id` (FK with ON DELETE SET NULL) ties an investigation to a customer. Index on `(last_used_at DESC NULLS LAST, created_at DESC)` for the Tools sidebar.
**Backwards compat:** /api/admin/v2/customers/[orgId]/notes (GET/POST/edit/delete/pin) and /api/admin/v2/tools/saved degrade gracefully when the tables are missing — surface clear "run M038" banners rather than 500. Old `note_add` audit rows from any pre-M038 manual notes (none exist today; the route was placeholder-only) stay readable in the Audit tab as historical records.
**Safety:** `CREATE TABLE IF NOT EXISTS`, indexes IF NOT EXISTS. Both have RLS enabled with no policy → service-role only. CHECK constraints on body/label/query length so an accidental dump doesn't bloat the table. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end: relation sizes + index list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M037 — Admin v2 Tools support (read-only SQL runner RPC) ✅ applied 2026-04-28
**File:** `M037-ADMIN-SQL-RUNNER.sql` (repo root)
**Purpose:** part of FIXES.md §0aj (Admin Console Rebuild PR 9 — Tools tab). Adds `admin_run_sql(p_query TEXT, p_limit INTEGER) RETURNS JSONB`. Validates that the query starts with `SELECT / WITH / TABLE / VALUES / EXPLAIN`, rejects any embedded semicolon (multi-statement guard), rejects every write/DDL/control keyword as a whole word (INSERT, UPDATE, DELETE, MERGE, DROP, ALTER, CREATE, TRUNCATE, GRANT, COPY, DO, CALL, VACUUM, ANALYZE, LOCK, SET, BEGIN, COMMIT, etc.), then wraps in `SELECT * FROM (user_query LIMIT N) t` so the only valid output is a row-set. `STABLE` is NOT used because plpgsql with `EXECUTE` can't be marked STABLE/IMMUTABLE; `SECURITY DEFINER` + `SET search_path = public, pg_catalog`. Sets `statement_timeout=10s` + `lock_timeout=2s` per call so a runaway query can't wedge a Supabase connection.
**Backwards compat:** /api/admin/v2/tools/sql gracefully degrades when the RPC is missing — surfaces a clear "M037 missing" banner rather than 500. JS-side regex validation is the primary defence; the RPC's checks are belt-and-braces.
**Safety:** `CREATE OR REPLACE FUNCTION`, wrapped in `BEGIN; … COMMIT;`. EXECUTE granted only to `service_role` (REVOKE ALL FROM PUBLIC first). Smoke-test queries at the bottom of the file (paste each individually): two should succeed, two should fail with `forbidden keyword` / `multi-statement` errors.
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M036 — Admin v2 Health support (cron_run_log + RLS-health RPC) ✅ applied 2026-04-28
**File:** `M036-ADMIN-HEALTH-CONFIG.sql` (repo root)
**Purpose:** part of FIXES.md §0ah (Admin Console Rebuild PR 7 — Health tab). Two related pieces in one migration:
  1. `cron_run_log(id, cron_name, started_at, finished_at, status, error, meta)` — table written by the new `lib/cron/log.ts::withCronLog` wrapper. The Admin v2 Health tab reads the most-recent row per `cron_name` to surface "last ran X ago / status / error". Two indexes: `(cron_name, started_at DESC)` for the hot per-cron lookup and `(status, started_at DESC)` for failure listings. RLS enabled; service-role only (no policy).
  2. `admin_health_rls()` RPC — returns one row per public-schema table with `(table_name, rls_enabled, policy_count, is_anomaly)`. Anomaly = RLS on but zero policies (table is fully locked to anon/authenticated). `STABLE`, `SECURITY DEFINER`, `SET search_path = public, pg_catalog`. EXECUTE granted only to `service_role`.
**Backwards compat:** Health endpoint degrades gracefully if either piece is missing — surfaces a clear "run M036" banner rather than 500ing. `withCronLog` is non-fatal on logging failures so an un-applied environment isn't bricked. Existing cron handlers are NOT yet wrapped; they'll show "never logged" in the Health tab until a follow-up PR opts each one in (one-line change per handler).
**Safety:** `CREATE TABLE IF NOT EXISTS`, indexes IF NOT EXISTS, `CREATE OR REPLACE FUNCTION`. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the end list `cron_run_log` size, confirm the function exists, and dump any current RLS anomalies (rows with `rowsecurity=true` and 0 policies).
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M033 — Atomic AI quota gate + 24h global-spend RPC ✅ applied 2026-04-28
**File:** `M033-INCREMENT-AI-USAGE-ATOMIC.sql` (repo root)
**Purpose:** part of FIXES.md §0w (Sprint 1 Tasks 4 + 5). Two related fixes in one migration:
  1. `increment_ai_usage_checked(org_id, date, limit)` — atomic `INSERT … ON CONFLICT DO UPDATE` returning `(new_count, allowed)`. Closes the TOCTOU window where 100 parallel `/api/ask` requests could all pass `checkAiLimit` before any increment landed and blow the per-org daily cap by the burst factor. Caller decrements when `allowed=false` so the rejected attempt doesn't tick the counter.
  2. `ai_spend_24h_global_usd()` — Postgres-side SUM for the global kill-switch denominator. Replaces the prior full table scan + sum-in-JS that pulled every row from the last 24 h on every AI call (~125k rows/day fetched at 50 customers). Single index scan now.
  3. Hot indexes for both rolling-window queries: `idx_ai_request_log_created_at` (DESC) for the global rolling sum, `idx_ai_request_log_org_created_at` for the per-org monthly ceiling check.
  4. Belt-and-braces `ALTER TABLE ai_usage_daily ADD CONSTRAINT … UNIQUE (org_id, date)` if missing — the ON CONFLICT path needs it. M002 should have added it; this is for environments rebuilt from older snapshots.
**Backwards compat:** legacy `checkAiLimit` + `incrementAiUsage` retained and `@deprecated`-tagged in `lib/ai/usage.ts`. Cron-driven AI agents (anomaly explainer, weekly digest, monthly forecast calibration) still use them — they run serially under cron locks so TOCTOU isn't an attack surface. RPC missing → both code paths fail OPEN (kill-switch disabled, fall back to non-atomic gate) so an unmigrated environment isn't bricked.
**Safety:** `CREATE OR REPLACE FUNCTION` + `CREATE INDEX IF NOT EXISTS`. Wrapped in `BEGIN; … COMMIT;`. Verification queries at the bottom list the new functions, indexes, and the unique constraint.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then manual burst test (FIXES §0w end): open 5 incognito tabs at `query_count = limit - 2`, fire `/api/ask` simultaneously, expect 2 succeed + 3 return 429 + counter ends at exactly `limit`.

### M032 — Fortnox supersede chain join table ✅ applied 2026-04-28
**File:** `M032-FORTNOX-SUPERSEDE-CHAIN.sql` (repo root)
**Purpose:** part of FIXES.md §0v (Sprint 1 Task 3). Adds `fortnox_supersede_links(child_id, parent_id, period_year, period_month)` so multi-month upload supersede chains preserve every period's parent. Pre-M032, `applyMonthly` overwrote the column-level `supersedes_id` / `superseded_by_id` on each iteration → only the last period's parent survived. Reject path now walks the join table to restore predecessors per-period; pre-fix it would only restore one predecessor for a multi-month rejected upload, leaving other periods data-less.
**Backwards compat:** column-level `supersedes_id` / `superseded_by_id` on `fortnox_uploads` remain; single-month uploads still write them accurately. Reject route falls back to the column when no link rows exist (older supersede chains pre-M032).
**Safety:** CREATE TABLE IF NOT EXISTS, indexes IF NOT EXISTS. RLS enabled with no SELECT/INSERT policy → service-role only access. Verify queries at the bottom confirm the column shape + index list.
**To apply:** open Supabase SQL Editor, paste file contents, run.

---

## Applied — for reference

### M035 — Agent settings table for kill switch (Admin v2 PR 6) ✅ applied 2026-04-28
**File:** `M035-ADMIN-AGENT-SETTINGS.sql` (repo root)
**Purpose:** part of FIXES.md §0ag. Created `agent_settings(key TEXT PK, is_active BOOLEAN, last_changed_at, last_changed_by, last_change_reason)`. Seeded the 6 known agent keys with `is_active=true`. The Admin v2 Agents tab toggles `is_active` to globally kill an agent.
**Verified 2026-04-28:** all 6 seed rows present (anomaly_detection / forecast_calibration / monday_briefing / onboarding_success / scheduling_optimization / supplier_price_creep), all `is_active=true`.
**Caveat:** cron handlers DO NOT yet check this column. The kill switch is visible + audited via the v2 Agents tab; wiring the crons to honour `is_active=false` is a small follow-up PR.

### M034 — Performance indexes for revenue_logs + staff_logs (Sprint 1.5) ✅ applied 2026-04-27
**File:** `M034-PERF-INDEXES.sql` (repo root)
**Purpose:** part of FIXES.md §0z (Sprint 1.5 Task 1). Both `revenue_logs` and `staff_logs` had ZERO indexes in any tracked migration — they pre-date the M008 summary-tables migration and were never retrofitted. `/api/departments` paginated through full table scans of both on every dashboard load. With <10k rows today the seq scan was invisible; at 50 customers × 2yr history (~200k+ rows) it would become the slowest query in the system.
**Indexes added (verified 2026-04-27):**
  - `idx_revenue_logs_org_biz_date` on `(org_id, business_id, revenue_date)` ✅
  - `idx_revenue_logs_org_provider_date` on `(org_id, provider, revenue_date)` ✅
  - `idx_staff_logs_org_biz_date` on `(org_id, business_id, shift_date)` ✅
  - `idx_staff_logs_org_group_date` on `(org_id, staff_group, shift_date)` ✅
**Pre-existing (not part of M034, no conflict):** `idx_staff_logs_date` on `(shift_date)` alone — slightly redundant with the composite, harmless.
**No code changes** — query plans pick up indexes automatically. New endpoints reading these tables MUST add their own index if they introduce a different shape; don't silently rely on these.

### M031 — POS completeness signal (`pos_days_with_revenue`) ✅ applied 2026-04-26
**File:** `M031-POS-COMPLETENESS.sql` (repo root)
**Purpose:** part of FIXES.md §0r. Adds `monthly_metrics.pos_days_with_revenue INT` so the aggregator can detect partial-month POS coverage and prefer Fortnox tracker_data when POS only synced a fraction of the month. Without this, partial POS revenue (e.g. PK integration added mid-month) would override full Fortnox revenue in `monthly_metrics`, producing absurd margins on the Performance page (Vero Nov 2025 showed −137 % margin from POS-revenue-vs-Fortnox-costs mismatch).
**Backfill:** counts distinct dates with non-zero revenue per (business, year, month) from `daily_metrics` and writes to the new column. Idempotent.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verification query at the end lists 2025 months by coverage % so you can spot the partial-month rows that the aggregator will now route to Fortnox.

### M030 — Re-categorise misclassified line items (one-off cleanup) ✅ applied 2026-04-26
**File:** `M030-RECATEGORIZE-LINE-ITEMS.sql` (repo root)
**Purpose:** companion to the FIXES.md §0o postscript fix in `extract-worker/route.ts::enrichLines`. Pre-fix, when the AI tagged a line as one category (e.g. 'revenue') but the Swedish label clearly meant another (e.g. 'reklam' = marketing → other_cost), the AI category was kept. Surfaced by the M029 verify query as 13 rows of `category='revenue' subcategory='marketing'` (50k kr).
**Mappings (all idempotent):**
  - subcategory ∈ {marketing, rent, utilities, accounting, audit, consulting, insurance, bank_fees, telecom, software, postage, shipping, office_supplies, cleaning, repairs, consumables, entertainment, vehicles, electricity} → category='other_cost'
  - subcategory ∈ {salaries, payroll_tax, pension} → category='staff_cost'
  - subcategory='depreciation' → category='depreciation'
  - subcategory ∈ {interest, interest_income} → category='financial'
**Safety:** UPDATE only flips `category`; subcategory + amount + label stay untouched. Wrapped in `BEGIN; … COMMIT;`. Verify queries at the end show the post-fix distribution and confirm `revenue` bucket is now clean (food/takeaway/alcohol/null only).
**To apply:** open Supabase SQL Editor, paste file contents, run.

### M029 — Revenue VAT-rate split (dine_in / takeaway / alcohol) ✅ applied 2026-04-26
**File:** `M029-REVENUE-VAT-SPLIT.sql` (repo root)
**Purpose:** part of FIXES.md §0o. Promotes the Swedish VAT-rate revenue split (12% = dine-in food, 6% = takeaway / Wolt-Foodora, 25% = alcohol) to first-class columns on `tracker_data`, matching what `revenue_logs` already has from the POS side. Surfaces takeaway revenue as a distinct slice so owners can see platform-delivery share (Wolt/Foodora take ~30% commission, so 100k of takeaway ≠ 100k of margin contribution).
Three concerns in one migration:
  1. Adds `dine_in_revenue`, `takeaway_revenue`, `alcohol_revenue` columns to `tracker_data`. Each is a SUBSET of `revenue` (never additive).
  2. Re-tags existing `tracker_line_items`: rows whose label contains "6% moms" or matches Wolt/Foodora/UberEats get `subcategory='takeaway'` (was 'food' from the legacy classifyByVat). 25%-moms rows that didn't get tagged get `subcategory='alcohol'`. Idempotent.
  3. Backfills the new columns from the re-tagged line items per (business, year, month). Caps each subset at total revenue (defensive against rounding).
**Safety:** all `ADD COLUMN` use `IF NOT EXISTS`. UPDATE statements include `IS DISTINCT FROM` guards so re-runs are no-ops. Backfill only writes when current value is 0. Wrapped in `BEGIN; … COMMIT;`.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verification queries at the bottom show the new columns + a backfilled-row count + the re-tagged subcategory distribution.

### M028 — Fortnox proper fix (depreciation/financial/alcohol_cost + supersede) ✅ applied 2026-04-26
**File:** `M028-FORTNOX-PROPER-FIX.sql` (repo root)
**Purpose:** part of FIXES.md §0n (Tier 2 architectural rebuild of the Fortnox extraction pipeline). Three concerns in one migration:
  1. Adds `depreciation`, `financial`, `alcohol_cost` columns to `tracker_data`. The first two were referenced everywhere but never existed in the schema; the apply route silently dropped them, /api/tracker silently overstated profit by the depreciation amount on every Fortnox month. `alcohol_cost` is promoted to a first-class rollup column so the Performance page reads the food/alcohol split from the rollup instead of summing line items.
  2. Adds `supersedes_id` + `superseded_by_id` columns to `fortnox_uploads` and expands the status check to include `'superseded'`. apply() now detects a prior applied upload for the same (business, year, month) and links them so re-uploads have a traceable chain instead of orphan rows. Also fixes the multi-month reject bug (line items deleted by source_upload_id, no period_month filter).
  3. Backfills (1) for already-applied uploads from `fortnox_uploads.extracted_json` so historical Performance page numbers become correct without forcing re-uploads. Recomputes `tracker_data.net_profit` + `margin_pct` for backfilled rows under the canonical formula (revenue − food − staff − other − depreciation + financial). Manual entries are not touched.
**Safety:** all `ADD COLUMN` operations use `IF NOT EXISTS`. Status check is dropped + recreated by name lookup so the migration is environment-portable. Backfill only writes when current value is 0 (never overwrites manual entries). Wrapped in `BEGIN; … COMMIT;` so a partial failure rolls back cleanly.
**To apply:** open Supabase SQL Editor, paste file contents, run. Verification queries at the bottom show the new columns + a count of backfilled rows.

### M027 — aggregation_lock (per-business serialisation for aggregateMetrics) ✅ applied 2026-04-26
**File:** `M027-AGGREGATION-LOCK.sql` (repo root)
**Purpose:** part of FIXES.md §0m (PK sync recurring failures, four-phase fix). Adds a tiny `aggregation_lock` table so `aggregateMetrics` can take a per-business advisory lock and prevent two concurrent sync paths (per-sync aggregate + post-cron aggregate sweep + on-demand /api/sync/today) from race-overwriting `daily_metrics` rows. Stale rows >60s are stolen. The §0l workaround mitigates the race; this lock cures it.
**Verified:** `aggregation_lock` table present with `business_id uuid PRIMARY KEY`, `locked_at timestamptz`, `locked_by text`.

### M024 — PK sync cursors (incremental fetch optimisation) ✅ applied 2026-04-26
**File:** `M024-PK-SYNC-CURSORS.sql` (repo root)
**Purpose:** add `integrations.pk_sync_cursors jsonb default '{}'::jsonb` column so master-sync can pass PK's `?sync_cursor=<last>` parameter and only fetch rows that changed/appeared since the last run, instead of refetching the full window. Roughly halves both PK API calls and Vercel function time on repeat syncs. Engine has structured-error fallback if the column is missing — now lifted.
**Verified:** `pk_sync_cursors jsonb DEFAULT '{}'::jsonb` present on `integrations`.

### M023 — reset stuck `status = 'error'` integrations (one-off backfill) ✅ applied 2026-04-23
**File:** `M023-RESET-STUCK-ERROR-STATUS.sql` (repo root)
**Purpose:** companion to code fix `d60d193`. Engine was only updating `last_sync_at` + `last_error` on success, never resetting `status` itself — so one-off failures stuck integrations in 'error' forever, excluding them from `/api/resync`, BackgroundSync, and catchup-sync (all filter on status='connected'). The backfill flipped rows where `last_sync_at` was within 48h AND `last_error` was empty back to 'connected'. Code fix prevents recurrence. Verified: 8 connected after run.

### M022 — integration reauth tracking ✅ applied 2026-04-22
**File:** `M022-INTEGRATION-REAUTH.sql` (repo root)
**Purpose:** support for the typed `PersonalkollenAuthError` path added in commit `ada0e7d`. When PK returns 401/403, sync engine flips `integrations.status` to `needs_reauth` and emails the org owner once per event — deduped via `reauth_notified_at` so a daily failed master-sync doesn't spam the inbox. Verified: `reauth_notified_at timestamptz` present, status CHECK widened to include `needs_reauth`.

### M015 — weather_daily
**File:** `sql/M015-weather-daily.sql`
**Purpose:** store observed + forecast weather per business per day. Feeds AI memo, scheduling suggestion, and `/weather` correlation page.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then hit `POST /api/admin/weather/backfill?secret=ADMIN_SECRET` once to populate historical rows. After that, daily sync keeps it current.

### M016 — memo_feedback
**File:** `sql/M016-memo-feedback.sql`
**Purpose:** stores thumbs up / thumbs down + optional comment on each Monday memo. Populated via the public `/api/memo-feedback` endpoint, secured by HMAC-signed tokens (key: `CRON_SECRET`) embedded in the email buttons.
**To apply:** open Supabase SQL Editor, paste file contents, run. No backfill needed — new memos from the next cron tick onward will include the feedback block. Requires M003 `briefings` already applied (FK target).

### M021 — pg_cron replaces fire-and-forget dispatcher
**File:** `M021-PG-CRON-EXTRACTION-SWEEPER.sql` (repo root)
**Purpose:** Claude.ai architecture review item 4 — replace `waitUntil(fetch())` dispatcher + Vercel cron with Supabase pg_cron firing the worker every 20 seconds. Kills the stuck-in-extracting class of failure at the DB layer (no HTTP hop between scheduler and DB). Paired `cc-reset-stale-extraction-jobs` cron runs the M017 reset RPC every minute so crashed workers release their claim automatically.
**Creates:** enables `pg_cron` + `pg_net` extensions; `fire_extraction_worker()` function that reads `cc_worker_url` + `cc_cron_secret` from Supabase Vault and POSTs to the worker endpoint; two scheduled jobs.
**Post-migration manual step:** after running the SQL, go to **Supabase Dashboard → Project Settings → Vault** and add two secrets:
  - `cc_worker_url` = `https://www.comandcenter.se/api/fortnox/extract-worker`
  - `cc_cron_secret` = `<your CRON_SECRET>` (from Vercel env vars)
The `fire_extraction_worker()` function reads these by name.
**To apply:** open Supabase SQL Editor, paste file contents, run. Then add the two Vault secrets. Verification query at bottom of the SQL file confirms both crons are scheduled.

### M020 — ai_forecast_outcomes (AI accuracy feedback loop)
**File:** `M020-AI-FORECAST-OUTCOMES.sql` (repo root)
**Purpose:** captures every AI-suggested budget/forecast prediction + the actual outcome once the period closes, so future AI prompts can include a "PRIOR ACCURACY" block and correct systematic bias. Not ML training — pure in-context feedback via future prompts.
**Creates:** `ai_forecast_outcomes` table (one row per business × period × surface), indexes for dispatch + unresolved lookup, RLS (org read + feedback-only UPDATE), `prune_ai_forecast_outcomes()` RPC for 3-year retention.
**Downstream:** `/api/budgets/generate` writes rows on each AI call; `/api/cron/ai-accuracy-reconciler` (daily 07:00 UTC) fills in actuals from monthly_metrics; budget generator reads last 12 months on next call.
**GDPR:** numeric values only, no PII. Tenant-isolated via RLS. Cascade deletes on org/business removal. 3-year retention enforced.
**To apply:** open Supabase SQL Editor, paste file contents, run. Idempotent.

### M019 — Supabase Realtime publication
**File:** `M019-REALTIME-PUBLICATION.sql` (repo root)
**Purpose:** adds `fortnox_uploads` and `extraction_jobs` to the `supabase_realtime` publication so the `/overheads/upload` page receives push updates instead of polling every 3 seconds. RLS policies still apply to Realtime events.
**To apply:** open Supabase SQL Editor, paste file contents, run. Idempotent.

### M018 — RLS gaps + Stripe dedup + org rate limits
**File:** `M018-RLS-GAPS-MIGRATION.sql` (repo root)
**Purpose:** enables RLS on 5 previously-exposed tables, replaces single-org `current_org_id()` with array-returning `current_user_org_ids()`, adds `stripe_processed_events` for webhook idempotency, adds `org_rate_limits` for persistent per-org rate limiting.
**Applied:** 2026-04-21 ✅

### M017 — extraction_jobs queue
**File:** `FORTNOX-JOBS-MIGRATION.sql` (repo root)
**Purpose:** job queue for async Fortnox PDF extraction. Replaces the request-bound extraction path with dispatcher → worker → sweeper architecture: dispatcher upserts a row, worker atomically claims jobs via `FOR UPDATE SKIP LOCKED`, sweeper cron resets stale 'processing' rows and fires workers for ready 'pending' rows. Retries with exponential backoff (30s / 2m / 10m), dead-letter after 3 attempts.
**Creates:** `extraction_jobs` table (one row per upload_id, UNIQUE), three RPCs (`claim_next_extraction_job`, `reset_stale_extraction_jobs`, `list_ready_extraction_jobs`), indexes for dispatch + stale detection, RLS read policy.
**To apply:** open Supabase SQL Editor, paste file contents, run. Idempotent. After applying, the `/api/cron/extraction-sweeper` endpoint starts serving traffic (cron schedule `*/2 * * * *`).

---

## How to use this file

When you run any SQL in the Supabase SQL Editor:
1. Add an entry below with the date, session, and exact SQL run
2. Mark whether it succeeded
3. Note any follow-up needed

This is the single source of truth for what the current schema looks like.

---

## Schema baseline (as of Session 5)

The following tables exist in production Supabase (llzmixkrysduztsvmfzi):

| Table | Key columns |
|-------|------------|
| organisations | id, name, plan, trial_ends_at, stripe_customer_id |
| organisation_members | org_id, user_id, role |
| businesses | id, org_id, name, city, is_active |
| integrations | id, org_id, business_id, provider, credentials_enc, status, last_sync_at, last_error |
| staff_logs | id, org_id, business_id, shift_date, staff_name, staff_group, staff_email, hours_worked, cost_actual, estimated_salary, ob_supplement_kr, ob_type, is_late, late_minutes, net_hours, breaks_seconds, real_start, real_stop, shift_start, shift_end, costgroup_name, costgroup_url, pk_log_url, pk_staff_url, pk_staff_id, pk_workplace_url, period_year, period_month |
| revenue_logs | id, org_id, business_id, revenue_date, revenue, covers, revenue_per_cover, transactions, tip_revenue, takeaway_revenue, dine_in_revenue, food_revenue, drink_revenue, provider |
| tracker_data | id, org_id, business_id, period_year, period_month, revenue, staff_cost, food_cost, drink_cost, rent, other_costs, net_profit |
| forecasts | id, org_id, business_id, period_year, period_month, revenue_forecast, staff_cost_forecast, margin_forecast |
| budgets | id, org_id, business_id, period_year, staff_budget, food_budget, drink_budget, rent_budget, other_budget |
| covers | id, org_id, business_id, date, total, revenue, revenue_per_cover |
| anomaly_alerts | id, org_id, business_id, alert_type, severity, title, description, metric_value, expected_value, deviation_pct, period_date, is_read, is_dismissed |
| gdpr_consents | id, org_id, user_id, consent_type, version, consented_at, withdrawn_at |
| deletion_requests | id, org_id, user_id, requested_at, status, completed_at, notes |
| onboarding_progress | id, org_id, step, metadata |

---

## Migration log

### M001 — 2026-04-10 — Session 5 — OB type and food/drink split
**Run**: 2026-04-10
**Status**: ✅ Success

```sql
ALTER TABLE staff_logs ADD COLUMN IF NOT EXISTS ob_type TEXT;
ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS food_revenue INTEGER DEFAULT 0;
ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS drink_revenue INTEGER DEFAULT 0;
```

---

### M002 — 2026-04-11 — Session 6 — AI query tracking
**Run**: 2026-04-11
**Status**: ✅ Success

```sql
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  UNIQUE(org_id, date)
);
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_usage_daily_select_own" ON ai_usage_daily
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

---

### M003 — 2026-04-17 — Session 7 — AI Agent Tables
**Run**: 2026-04-17
**Status**: ✅ **SUCCESS** — Verified via Supabase REST probe: all 3 tables + `integrations.onboarding_email_sent` column present

```sql
-- Table for forecast calibration agent (runs 1st of month)
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forecast_calibration_select_own" ON forecast_calibration
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for scheduling optimization agent (runs weekly)
CREATE TABLE IF NOT EXISTS scheduling_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ DEFAULT now(),
  recommendations TEXT NOT NULL,
  analysis_period TEXT,
  metadata JSONB
);
ALTER TABLE scheduling_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduling_recommendations_select_own" ON scheduling_recommendations
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for Monday briefing agent (needs Resend)
CREATE TABLE IF NOT EXISTS briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  content TEXT NOT NULL,
  key_metrics JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, week_start)
);
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "briefings_select_own" ON briefings
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Column for onboarding success agent
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

**Follow-up**: Run this SQL in Supabase SQL Editor before deploying AI agents.

---

### M006 — 2026-04-16 — Session 8 — Departments table
**Run**: ⏳ **PENDING** — Run in Supabase SQL Editor before using /departments page

```sql
-- Department definitions — one row per department per business
-- Maps department name → used as PK staff_group AND Inzii integration key
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6366f1',
  sort_order  INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, name)
);
CREATE INDEX IF NOT EXISTS idx_departments_org ON departments(org_id);
CREATE INDEX IF NOT EXISTS idx_departments_biz ON departments(business_id);
```

**After running SQL**: Go to Admin panel → expand Vero Italiano → click "Setup departments →" button
This auto-creates department records from the existing Inzii integrations.

---

### M005 — 2026-04-15 — Session 7 — Inzii POS department support
**Run**: 2026-04-15
**Status**: ✅ Complete — both steps confirmed (all 6 Inzii dept rows inserted, constraint fix working)

```sql
-- Step 1: Add department column (run first)
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS department TEXT;

-- Step 2: Replace single unique constraint with two partial indexes
-- Old constraint only allowed one integration per provider per business.
-- New indexes allow multiple Inzii rows (one per department) while keeping
-- the single-row-per-provider rule for all other integrations.
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_business_id_provider_key;
ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_org_business_provider_unique;

CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq_with_dept
  ON integrations (business_id, provider, department)
  WHERE department IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS integrations_uniq_no_dept
  ON integrations (business_id, provider)
  WHERE department IS NULL;
```

---

### M004 — 2026-04-15 — Session 6 — AI Agent Support Tables
**Run**: 2026-04-15
**Status**: ⏳ **PENDING** — Optional, for future agents

```sql
-- Table for supplier price creep agent (when Fortnox OAuth approved)
CREATE TABLE IF NOT EXISTS supplier_price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  detected_at TIMESTAMPTZ DEFAULT now(),
  supplier_name TEXT,
  item_name TEXT,
  old_price NUMERIC,
  new_price NUMERIC,
  increase_pct NUMERIC,
  invoice_date DATE,
  alert_severity TEXT CHECK (alert_severity IN ('low', 'medium', 'high')),
  is_resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT
);
ALTER TABLE supplier_price_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "supplier_price_alerts_select_own" ON supplier_price_alerts
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Table for anomaly detection agent email tracking
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE anomaly_alerts ADD COLUMN IF NOT EXISTS email_recipients TEXT[];
```

---

## SQL to Run Now for AI Agents

Copy and paste this into Supabase SQL Editor:

```sql
-- M003: AI Agent Tables
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;
CREATE POLICY "forecast_calibration_select_own" ON forecast_calibration
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS scheduling_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  generated_at TIMESTAMPTZ DEFAULT now(),
  recommendations TEXT NOT NULL,
  analysis_period TEXT,
  metadata JSONB
);
ALTER TABLE scheduling_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "scheduling_recommendations_select_own" ON scheduling_recommendations
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;

-- Mark as executed after running
-- ✅ EXECUTED 2026-04-15
```

---

## Current Schema Summary

### AI Agent Tables (Session 6)
1. **`ai_usage_daily`** — AI query limits per org per day
2. **`forecast_calibration`** — Forecast accuracy and bias factors (monthly)
3. **`scheduling_recommendations`** — Staff scheduling optimizations (weekly)
4. **`briefings`** — Monday briefing content (when Resend verified)
5. **`supplier_price_alerts`** — Supplier price increases (when Fortnox connected)

### Agent Status
- ✅ **Anomaly detection** — Live, uses `anomaly_alerts` table
- ✅ **Forecast calibration** — Ready, needs `forecast_calibration` table
- ✅ **Scheduling optimization** — Ready, needs `scheduling_recommendations` table
- ✅ **Supplier price creep** — Skeleton built, needs `supplier_price_alerts` table
- 🔄 **Onboarding success** — In progress, uses `onboarding_email_sent` column
- 📋 **Monday briefing** — Planned, needs `briefings` table

---

## M006 — 2026-04-15 — Session 7 — API Schema Discovery Agent
**Run**: 2026-04-15 ✅
**Status**: ✅ **SUCCESS** — Migration executed successfully

```sql
-- Table for API Schema Discovery Agent
CREATE TABLE IF NOT EXISTS api_discoveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  discoveries JSONB,
  suggested_mappings JSONB,
  recommendations JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);
ALTER TABLE api_discoveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_discoveries_select_own" ON api_discoveries
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Add last_discovery_at column to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_discovery_at TIMESTAMPTZ;
```

**Purpose**: Stores API schema discoveries and suggested mappings for the API Schema Discovery Agent.
**Agent**: `/api/cron/api-discovery` — analyzes API endpoints and suggests mappings to CommandCenter schema.

---

## M007 — 2026-04-16 — Session 7 — Enhanced API Discovery tables
**Run**: ✅ **COMPLETE** — Executed in Supabase SQL Editor during Session 7
**Status**: ✅ COMPLETE

```sql
-- Add missing columns to integrations table
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS last_enhanced_discovery_at TIMESTAMPTZ;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS provider_type TEXT;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS api_endpoints_cache TEXT;

-- Create api_discoveries_enhanced table
CREATE TABLE IF NOT EXISTS api_discoveries_enhanced (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_type TEXT,
  analysis_result JSONB,
  discovered_at TIMESTAMPTZ DEFAULT now(),
  confidence_score INTEGER DEFAULT 0,
  data_type TEXT,
  unused_fields_count INTEGER DEFAULT 0,
  business_insights_count INTEGER DEFAULT 0,
  UNIQUE(integration_id)
);
ALTER TABLE api_discoveries_enhanced ENABLE ROW LEVEL SECURITY;
CREATE POLICY "api_discoveries_enhanced_select_own" ON api_discoveries_enhanced
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- Create implementation_plans table
CREATE TABLE IF NOT EXISTS implementation_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  phase1_tasks JSONB,
  phase2_tasks JSONB,
  phase3_tasks JSONB,
  estimated_timeline TEXT,
  generated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(integration_id)
);
ALTER TABLE implementation_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "implementation_plans_select_own" ON implementation_plans
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));
```

---

## M008 — 2026-04-17 — Session 8 — Onboarding step + metadata columns
**Run**: 2026-04-17
**Status**: ✅ **SUCCESS** — verified via REST probe

```sql
ALTER TABLE onboarding_progress ADD COLUMN IF NOT EXISTS step TEXT;
ALTER TABLE onboarding_progress ADD COLUMN IF NOT EXISTS metadata JSONB;
```

**Why**: `/api/onboarding/setup-request` was writing to `step` and `metadata` columns that didn't exist, so every new customer's setup-form data (restaurant name, city, staff system, accounting, POS) was silently dropped. Admin panel's "Setup requests" section was always empty. After this migration, signup metadata persists and admin renders correctly.

---

## M009 — 2026-04-18 — Session 10 — Deletion requests audit table
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS**
**File**: `sql/M009-deletion-requests.sql`

Creates `public.deletion_requests` — tamper-evident audit of every GDPR Art. 17 hard delete. Written before purge, updated after. Retained indefinitely as compliance evidence. RLS enabled, no policies (service-role only).

---

## M010 — 2026-04-18 — Session 10 — Admin audit log
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS**
**File**: `sql/M010-admin-audit-log.sql`

Creates `public.admin_audit_log` — every mutation by an admin gets a row (impersonate, key edits, integration deletes, hard deletes, trial extensions, agent toggles, etc.). Three indexes: per-org, per-action, per-date. Retained 2+ years for GDPR Art. 32 evidence. Paired with new `lib/admin/audit.ts` helper and `/admin/audit` viewer page.

---

## M011 — 2026-04-18 — Session 10 — Unique constraints on upsert targets
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS** — all 7 partial unique indexes verified via `pg_indexes`
**File**: `sql/M011-unique-constraints.sql`

Closes a correctness-bug class: `lib/sync/engine.ts` upserts rely on `onConflict` keys that had no matching unique constraint, meaning duplicates silently accumulated. Each block dedupes (keeps newest by `created_at` DESC / `id` DESC) then adds a partial unique index (`WHERE business_id IS NOT NULL` pattern handles the nullable-column issue where Postgres treats NULLs as distinct).

Indexes created:
- `revenue_logs_org_biz_provider_date_unique` on (org_id, business_id, provider, revenue_date)
- `covers_business_date_unique` on (business_id, date)
- `staff_logs_pk_log_url_unique` on (pk_log_url)
- `integrations_org_biz_provider_dept_unique` on (org_id, business_id, provider, COALESCE(department, ''))
- `integrations_org_null_biz_provider_unique` on (org_id, provider, COALESCE(department, '')) WHERE business_id IS NULL
- `forecasts_org_biz_period_unique` on (org_id, business_id, period_year, period_month)
- `tracker_data_biz_period_unique` on (business_id, period_year, period_month)

Note for future migrations: `revenue_logs` and `forecasts` do not have `updated_at`; `integrations` does not have `connected_at`. Initial M011 file referenced those columns and had to be patched to use `created_at DESC NULLS LAST, id DESC` everywhere.

---

## M012 — 2026-04-18 — Session 10 — Orphan-table authoritative schema
**Run**: 2026-04-18
**Status**: ✅ **SUCCESS** (after sync_log schema drift patch)
**File**: `sql/M012-orphan-tables.sql`

Documents every table the code reads/writes that never had a formal migration. Each `CREATE TABLE IF NOT EXISTS` is a no-op if the table already exists — safe to run repeatedly. Tables codified: `billing_events`, `invoices`, `feature_flags`, `support_notes`, `support_tickets`, `supplier_mappings`, `pk_sale_forecasts`, `financial_logs`, `api_credentials`, `api_probe_results`, `integration_health_checks`, `pos_connections`, `sync_log`, `customer_health_scores`, `ai_usage`, `ai_request_log`, `export_schedules`, `notebook_documents`.

**Patch applied during run**: `sync_log` existed in prod without the `integration_id` column, so the `CREATE INDEX … ON sync_log (integration_id, …)` statement failed with `42703`. Fix: reshaped sync_log section to `CREATE TABLE IF NOT EXISTS` with only the original five columns, then `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for the seven drifted columns (`business_id`, `integration_id`, `records_synced`, `date_from`, `date_to`, `error_msg`, `duration_ms`). Re-run after patch succeeded.

---

## M131 — Diacritic-insensitive search (2026-06-05)

**Status**: APPLIED ✓
**File**: `sql/M131-UNACCENT-SEARCH-COLUMNS.sql`

Enables `unaccent` + `pg_trgm` extensions. Adds immutable `public.f_unaccent(text)` wrapper (required for STORED generated columns since stock `unaccent()` is STABLE). Adds two STORED generated columns:
- `products.name_unaccent` — `lower(f_unaccent(name))`
- `supplier_invoice_lines.raw_description_unaccent` — `lower(f_unaccent(raw_description))`

Plus trigram GIN indexes on each for fast `%substring%` ilike.

Used by: link-article picker, items orphan-line discovery, products name search, Ask CC `search_inventory_products`. JS helper `lib/inventory/unaccent.ts` mirrors the SQL so query side normalises in JS, data side in Postgres, both produce the same form.

Owner-facing effect: typing "creme" matches "Crème" and vice versa; same for café/cafe, smörgås/smorgas, etc.

---

## M132 — Global product enrichment schema (2026-06-05)

**Status**: PENDING — file written, awaiting owner SQL editor apply
**File**: `sql/M132-GLOBAL-PRODUCT-ENRICHMENT.sql`
**Plan**: `docs/GLOBAL-PRODUCT-ENRICHMENT-PLAN.md`

Phase 1 of the cross-customer enrichment work. Schema only — no app code yet (Phase 2 ships the write hook).

Changes:
1. Adds 7 columns to `supplier_articles`: `refined_pack_size`, `refined_base_unit`, `refined_weight_per_piece_g`, `refined_density_g_per_ml`, `refined_category`, `refined_confidence smallint NOT NULL DEFAULT 0`, `refined_last_updated_at`. Plus CHECK constraints for confidence (0-2) and category (whitelisted values).
2. Creates `supplier_article_refinement_log` table — audit trail of every customer save against (supplier, article). FK to `supplier_articles` (composite PK) + FK to `businesses` with cascade. Whitelisted `field` CHECK so only the share-safe attributes can be logged. Indexes on (supplier_fortnox_number, article_number), business_id, field.
3. Adds `businesses.share_refinements_with_platform boolean NOT NULL DEFAULT true` — opt-out flag for privacy / GDPR.

Idempotent throughout (IF NOT EXISTS on columns/tables/indexes, DO $$ pg_constraint guards on CHECK constraints).

No data backfill — refined values stay NULL until Phase 2 ships and customers start saving.

Verification queries included at the bottom of the SQL file (commented out — uncomment to spot-check after apply).

---

## M135 — Ingestion ledger + row-level completeness (2026-06-06)

**Status**: PENDING — file written, awaiting owner SQL editor apply
**File**: `sql/M135-INGESTION-LEDGER.sql`
**Plan**: `docs/INGESTION-PIPELINE-RELIABILITY-PLAN.md`

Phase 1 of the ingestion-pipeline reliability work. Triggered by the 2026-06-06 file_id incident — 99% of `fortnox_supplier_invoices` had `file_id=null` because the sync skipped the file-connections endpoint and nothing alarmed because there was no completeness contract.

Changes:
1. Creates `ingestion_log` global audit table — one row per external API call (source, resource, business_id, operation, started_at, finished_at, expected_fields jsonb, populated_fields jsonb, rows_processed, status, error, context).
2. Adds `fortnox_supplier_invoices.ingestion_status text` (CHECK in {complete, partial, header_only, failed}) + `ingestion_meta jsonb` for per-row completeness. Default `header_only` — every existing row is truthfully tagged as "we only fetched the header" since the sync never asked for file_id.
3. Truthful backfill: existing rows where `file_id IS NOT NULL` (Vero PDF extraction worker output) flip to `complete` with `ingestion_meta.source_path='pdf_extraction_worker'`.

Companion code:
- `lib/ingestion/ledger.ts` — helper API (`openLedger / closeLedger / computeRowStatus / buildIngestionMeta`). Defensive — ledger write failures don't break the actual sync.
- `app/api/cron/fortnox-supplier-sync/route.ts` — first user. Every page-fetch + upsert opens/closes a ledger row; every upserted invoice carries `ingestion_status + ingestion_meta`.
- `app/api/inventory/invoice-pdf/route.ts` — reads `ingestion_status`; when previously `header_only` and the live Fortnox re-check still finds no PDF, message confirms "we just checked" rather than the old "no PDF on Fortnox" claim.

Idempotent (IF NOT EXISTS on table/columns/indexes; DO $$ pg_constraint guard on CHECK). Safe to re-run.

Verification queries at the bottom of the SQL file (commented out).

Phase 2 (next session, parked): fix supplier-sync to also call /3/supplierinvoicefileconnections during sync + backfill existing rows. With the M135 completeness flag in place, the fix can be verified by watching `ingestion_status` flip from `header_only` to `complete` across the ~1,800 historical rows.

---

## Next Steps

1. **Run M007 SQL** — required for Enhanced API Discovery to work
2. **Run M003 SQL** in Supabase SQL Editor (if not already done)
3. **Deploy AI agents** to Vercel
4. **Test cron jobs** with Bearer token
5. **Monitor logs** for agent execution
6. **Update this file** with execution status

---

*Always update this file before and after running SQL in Supabase.*

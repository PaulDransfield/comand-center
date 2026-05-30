# CommandCenter — Current-State Investigation Report

> Read-only reconnaissance. No code or DB changed during this investigation.
> Date: 2026-05-30. Author: Claude Code (CLI). Repo SHA at HEAD: `917c376`.

This report answers the twelve questions in
`claude-code-investigation-prompt.md`. Where a question is unanswered I write
**Not found** rather than guess. Citations are `file:line`.

---

## 1. Repo & stack orientation

### 1.1 Top-level layout

```
app/                Next.js 14 App Router — pages + API routes
  api/              48 sub-directories (one per area) — server routes
    cron/           49 cron handlers (vercel.json wires them; see §9)
  (auth pages, dashboard, inventory, fortnox, integrations, …)
lib/                Domain modules (one folder per area)
  ai/               models, snapshot, scope, contextBuilder, agent-registry, …
  fortnox/          api/, classify, validators, ai-auditor, voucher-cache, …
  inventory/        matcher, normalise, pdf-extractor, recipe-cost,
                    unit-conversion, fx, suppliers, categories, …
  forecast/         daily, daily-v2, hourly, monthly, llm-adjust, recency
  finance/          projectRollup, conventions, period-closure
  pos/              personalkollen, onslip, swess (parked), wolt, …
  reports/          builders, margin-report, margin-pptx, pptx, docx, xlsx
  email/            sendEmail + per-template senders (Resend)
  supabase/         server (createAdminClient), client, ssr
  middleware/       org-rate-limit, rate-limit
  monitoring/       sentry-scrub
  ...
components/         shared React UI (KPI cards, banners, AppShell, ConsentBanner)
context/            BizContext (selected business)
i18n/               request.ts (next-intl wiring)
locales/            sv / en / no JSON message bundles
sql/                M048–M104 migrations (authoritative; see §1.3)
archive/migrations/ M008–M047 + legacy schemas (NOT authoritative for prod schema — see §12)
scripts/            tsx scripts (diagnostics, one-offs)
tests/              (sparse — single-file ad-hoc)
docs/investigation/ this report
middleware.ts       Edge auth gate (cheap structural JWT check)
vercel.json         crons list (one entry per scheduled job)
next.config.js      Sentry + next-intl + bundle-analyzer wrappers
CLAUDE.md           operating rules (single source of truth)
ROADMAP.md / FIXES.md / MIGRATIONS.md / many *-PLAN.md docs
```

### 1.2 Stack versions (from `package.json`)

| Dep | Version |
|-----|---------|
| `next`                    | `14.2.0` (App Router) |
| `react` / `react-dom`     | `^18.3.0` |
| `typescript`              | `^5.0.0` |
| `@supabase/ssr`           | `^0.3.0` |
| `@supabase/supabase-js`   | `^2.43.0` |
| `@anthropic-ai/sdk`       | `^0.24.0` (OUTDATED — see §12) |
| `next-intl`               | `^4.11.0` |
| `@sentry/nextjs`          | `^10.48.0` |
| `stripe`                  | `^15.0.0` |
| `resend`                  | `^3.2.0` |
| `pdf-parse`               | `^2.4.5` |
| pdfjs-dist                | (required at runtime, externalised in `next.config.js:36`) |
| `@react-pdf/renderer`     | `^4.5.1` (PDF generation) |
| `docx` / `pptxgenjs` / `xlsx` | report generators |

Node runtime: `runtime = 'nodejs'` declared on individual API routes.
`preferredRegion = 'fra1'` on the Fortnox sync cron
(`app/api/cron/fortnox-supplier-sync/route.ts:27`).
No top-level `package.json#engines` pin.

### 1.3 Migrations: tool, naming, location

- **Naming convention:** `M0xx-NAME-IN-CAPS.sql` (e.g. `M075-INVENTORY-CATALOGUE.sql`).
- **Authoritative location:** `sql/` — files M008–M104 with gaps (see file listing).
  Higher M-numbers (M048+) are the current scheme; M008–M016 also live here.
- **Legacy location:** `archive/migrations/` — files M017–M047 plus old schema dumps
  (`supabase_schema.sql`, `integrations-schema.sql`, `bankid-schema.sql`,
  `ai-schema.sql`, `support_schema.sql`, `M018-RLS-GAPS-MIGRATION.sql`,
  `M046-ONBOARDING-EXPANSION.sql`, etc.). **CLAUDE.md L235 explicitly warns
  `archive/migrations/*.sql` are NOT authoritative for prod schema** — the
  prod schema can have constraints these files declare which never landed,
  or vice versa. Verify via `pg_indexes` / `pg_constraint` when load-bearing.
- **Application:** by hand, via Supabase SQL Editor (per CLAUDE.md §3
  "Provide SQL for any DB changes, formatted for Supabase SQL Editor").
  Status is tracked in `MIGRATIONS.md` with "applied" / "pending application" tags
  (M097, M098, M100, M104 currently pending — see §12).
- **Idempotency:** every migration uses `IF NOT EXISTS` / `DO $$ IF NOT EXISTS … $$`
  blocks. Re-runs are safe.

### 1.4 AI model strings (single source of truth)

`lib/ai/models.ts` exports:

```ts
export const AI_MODELS = {
  AGENT:    'claude-haiku-4-5-20251001',
  ANALYSIS: 'claude-sonnet-4-6',
  ASSISTANT:'claude-sonnet-4-6',
} as const
export const MAX_TOKENS = {
  AGENT_EXPLANATION: 150, AGENT_SUMMARY: 300,
  AGENT_RECOMMENDATION: 400, ASSISTANT: 2000,
} as const
```

CLAUDE.md §11 rule: **never hardcode model strings — import from
`lib/ai/models.ts`**. Both `lib/inventory/pdf-extractor.ts:132,159` and
all forecast / agent surfaces follow this.

Other AI infrastructure modules:
- `lib/ai/snapshot.ts` — full business context payload for every AI call
- `lib/ai/contextBuilder.ts` — consolidated `/api/ask` enrichment
- `lib/ai/scope.ts` — shared `SCOPE_NOTE` (business-wide vs department; CLAUDE.md §10c)
- `lib/ai/rules.ts` — shared benchmarks / scheduling-asymmetry / voice rules
- `lib/ai/agent-registry.ts` / `lib/ai/outcomes.ts` — agent execution + outcome capture
- `lib/ai/usage.ts` — `logAiRequest()` + `checkAndIncrementAiLimit()` (CLAUDE.md §Session 21 invariants)
- `lib/ai/anthropic-fetch.ts` — shared Anthropic HTTP helper with 429/5xx retry +
  Retry-After (CLAUDE.md Session 21). **Not yet used by `pdf-extractor.ts`** —
  it has its own retry loop at lines 791–829.

---

## 2. Multi-tenancy & franchise model

### 2.1 Tenant model

Two-level hierarchy: **organisation → business**.

`organisations` (`archive/migrations/supabase_schema.sql:18-32`):
```
id, name, slug UNIQUE, plan CHECK IN ('trial','starter','pro','enterprise'),
trial_start, trial_end, billing_email, stripe_customer_id,
stripe_subscription_id, is_active, metadata JSONB, created_at, updated_at
```
The plan enum is widened by `sql/M063-ORGANISATIONS-PLAN-CONSTRAINT.sql` (current
plans are Solo / Group / Chain — CLAUDE.md memory `project_pricing_2026_04`).
`organisations.org_number` was added by archived `M042-COMPANY-ORG-NUMBER.sql`.

`businesses` (supabase_schema.sql:65-84) — restaurant locations within an org:
```
id, org_id FK→organisations, name, type, org_number, address, city,
country DEFAULT 'SE', currency DEFAULT 'SEK',
target_food_pct/target_staff_pct/target_rent_pct/target_margin_pct,
colour, is_active, setup_complete, created_at, updated_at
```
Extended later by:
- `M046-ONBOARDING-EXPANSION.sql`: `opening_days` JSONB default
  `{mon..sun:true}`, `business_stage` TEXT CHECK IN
  ('new','established_1y','established_3y')
- `sql/M054-BUSINESS-CLUSTER-COLUMNS.sql`: `cuisine`, `location_segment`,
  `size_segment`, `kommun` (manually populated for Vero today)
- `sql/M079-BUSINESSES-LEGAL-NAME.sql` + `sql/M081-BUSINESSES-SETUP-HEALTH.sql`
  (legal_name, setup-health fields)
- `vat_filing_cadence` referenced from
  `app/api/integrations/fortnox/route.ts:298` (defaulted to `'quarterly'` on
  Fortnox connect)

`organisation_members` (supabase_schema.sql:48-57): `(org_id, user_id, role)`
with `role CHECK IN ('owner','admin','viewer')`. UNIQUE(org_id, user_id).
M043 added a finer role scheme; M072 added a `revisor` role.

`integrations` (supabase_schema.sql:91-105): `(org_id, business_id, provider,
status, credentials_enc, config JSONB, token_expires_at, …)` with `UNIQUE
(business_id, provider)` in the archive file. **Prod actually has** the
non-partial `integrations_org_biz_provider_uniq` added by M049 (per CLAUDE.md
Session 17 invariants L93) — the archived UNIQUE never landed.

### 2.2 Group → location (franchise) concept

- The org → business hierarchy IS a one-org-many-restaurants shape (Vero
  has two businesses: Vero Italiano + Rosali Deli per CLAUDE.md §3 Key IDs).
- `sql/M054-BUSINESS-CLUSTER-COLUMNS.sql` + `sql/M055-BUSINESS-CLUSTER-MEMBERSHIP.sql`
  add a cluster taxonomy (`cuisine` / `location_segment` / `size_segment` /
  `kommun`) and a many-to-many `business_cluster_membership(business_id,
  cluster_dimension, cluster_value, manually_set)`. This is for
  **cross-business AI peer learning**, not legal franchise structure.
- **No "franchise master vs location" concept exists.** No `parent_business_id`,
  no `franchise_group_id`, no recipe/inventory inheritance between locations.
  Each business is independent inside its org.
- `app/group/` exists (page route) and there's `app/api/group/` — these surface
  cross-business KPIs for the same org, not franchise master data.

### 2.3 Tenant isolation (RLS)

Pattern (from `archive/migrations/M018-RLS-GAPS-MIGRATION.sql`):
- `current_user_org_ids()` returns `uuid[]` — array of every org the
  caller belongs to. SECURITY DEFINER. Critical: per CLAUDE.md L162
  memory `feedback_rls_uuid_array_function`, policies MUST use
  `org_id = ANY(current_user_org_ids())`. Using `IN (SELECT …)` errors
  with 42883 (`uuid = uuid[]`).
- `current_org_id()` returns the **first** org_id (backwards-compat alias).
- Legacy single-org policies migrated to ANY-array in M018 §3 for
  `tracker_data`, `tracker_line_items`, `notebooks`, `documents`.
- M018 §1 enables RLS + adds select policies on `auth_events`,
  `bankid_sessions`, `email_log`, `gdpr_consents`, `onboarding_progress`.

Every newer table follows the same pattern:
- `sql/M075` enables RLS on `products`, `product_aliases`,
  `supplier_invoice_lines` with `org_id = ANY(current_user_org_ids())`.
- `sql/M083` (`supplier_classifications`), M084 (`recipes`,
  `recipe_ingredients`), M091 (`stock_locations`), M092 (`stock_counts`,
  `stock_count_lines`), M093 (`waste_log`), M097 (`pos_menu_items`,
  `pos_sales`), M098 (`fortnox_supplier_invoices`, `fortnox_sync_state`),
  M099 (`inventory_review_suggestions`, `inventory_review_outcomes`),
  M078 (`invoice_pdf_extractions`), M080 (`fortnox_vouchers_cache`) — all RLS
  via `current_user_org_ids()`.

API-layer cross-tenant gate: every route that accepts `business_id` must
call `requireBusinessAccess(auth, businessId)` (CLAUDE.md Session 21
invariants L8 + memory `feedback_oauth_business_confirmation`).

### 2.4 Intentionally shared (cross-tenant) tables today

Searching produced exactly two cross-tenant shared tables that are
not org-scoped:

- **`fx_rates`** (`sql/M088-FX-RATES.sql`) — daily ECB rates,
  global, no `org_id`. Read by everyone. No RLS policy needed
  (read-only reference data).
- **`school_holidays`** (`sql/M056-SCHOOL-HOLIDAYS.sql` + seed rows in
  M067/M068) — Swedish municipality school holidays keyed by `kommun`/`lan`.
  Reference data, no `org_id`.

There are no "shared product taxonomy" or "shared supplier-name dictionary"
tables today — the supplier-name classifier is hardcoded in
`lib/inventory/suppliers.ts` (90-line dictionary), and the BAS-account
classifier is hardcoded in `lib/inventory/categories.ts`. Both ship in
application code, not DB.

---

## 3. Invoice ingestion & extraction pipeline (current)

### 3.1 Where invoices arrive

There are **two ingestion paths** running side by side:

1. **Fortnox API path** (canonical going forward per CLAUDE.md memory
   `project_api_priority_strategy`):
   - Daily cron `/api/cron/fortnox-supplier-sync`
     (`app/api/cron/fortnox-supplier-sync/route.ts`, schedule
     `vercel.json:11` = `10 6 * * *`). For each connected Fortnox
     integration, pulls `/3/supplierinvoices?fromdate=…&todate=…&limit=500&page=N`
     into the `fortnox_supplier_invoices` cache (M098, **pending application**
     per `MIGRATIONS.md`). First run backfills 12 months, subsequent runs
     resume from `fortnox_sync_state.last_cursor_date` minus one day.
   - PDF attachment is **not** stored in our DB. `file_id` is fetched lazily
     on first PDF view; `app/api/integrations/fortnox/invoice-pdf/route.ts`
     proxies the binary via `/3/inbox/{file_id}` then `/3/archive/{file_id}`
     fallback (same pattern in
     `lib/inventory/pdf-extractor.ts:577-589`).
   - Per-line product data comes from `/3/supplierinvoices/{n}` detail call —
     run by `lib/inventory/backfill-worker.ts`.
2. **Direct PDF upload path** (Resultatrapport P&L PDFs):
   - `app/api/fortnox/upload/route.ts` accepts a multipart PDF upload,
     stores it in Supabase Storage bucket `fortnox-pdfs`, then enqueues an
     extraction via `fortnox_uploads` row.
   - `app/api/fortnox/extract-worker/route.ts` performs PDF→JSON extraction
     (parser-first, Claude fallback — see §3.2).
   - `app/api/fortnox/apply/route.ts` runs validators + AI auditor, then
     writes `tracker_data` + `tracker_line_items` via
     `lib/finance/projectRollup.ts`.

### 3.2 PDF→structure detection + extraction flow

For **Resultatrapport P&Ls** (the monthly accountant output):
- `lib/fortnox/resultatrapport-parser.ts` — deterministic, pdfjs-based parser.
  Tries first. Free, ~100 ms.
- If parser fails or low confidence: extract-worker calls Claude
  (`claude-sonnet-4-6` via `lib/ai/models.ts`) with extended thinking + tool
  use + prompt caching, per CLAUDE.md memory `feedback_fortnox_extraction_stack`.
- Output goes through `lib/fortnox/classify.ts::classifyByAccount` (BAS),
  `classifyLabel` (Swedish keyword dictionary), `classifyByVat` (Swedish VAT
  rates → category — see §8).

For **supplier-invoice PDFs** (the per-supplier itemised PDFs):
- `lib/inventory/pdf-extractor.ts` — Claude Vision path B. **Haiku 4.5 first
  pass with Sonnet 4.6 escalation** (lines 122–171) — cascade is unique to
  this file; per CLAUDE.md §5 ~70-80 % clear on Haiku.
- PDF bytes fetched via Fortnox `/3/inbox/{file_id}` then `/3/archive/{file_id}`
  fallback (`lib/inventory/pdf-extractor.ts:577-589`).
- Max PDF size 10 MB (line 73 `PDF_BYTES_LIMIT`).
- Persistence via RPC `apply_invoice_pdf_extraction()` (`sql/M078-INVOICE-PDF-EXTRACTIONS.sql:120-194`)
  which atomically DELETEs + INSERTs `supplier_invoice_lines` rows for that
  invoice (re-extraction replaces, never duplicates).

### 3.3 Exact JSON schema the supplier-invoice extractor emits

From `lib/inventory/pdf-extractor.ts:717-753` (tool input schema sent
to Claude, with `tool_choice: { type: 'tool', name: 'record_invoice_rows' }`):

```jsonc
{
  "rows": [{
    "row_number":     "integer",            // required, 1-based sequential
    "description":    "string",             // required, brand+variant+size
    "article_number": "string | null",      // supplier SKU if printed
    "quantity":       "number | null",
    "unit":           "string | null",      // st / kg / l / dl / …
    "price_per_unit": "number | null",
    "total_excl_vat": "number",             // required
    "vat_rate":       "number | null"       // 0 / 6 / 12 / 25
  }],
  "header": {
    "invoice_total_excl_vat": "number | null",
    "invoice_total_inc_vat":  "number | null",
    "supplier_org_number":    "string | null",
    "invoice_date":           "string | null",
    "currency":               "string | null"   // ISO 4217 (SEK/EUR/USD/NOK/DKK/GBP), null → SEK
  }
}
```

The Resultatrapport extractor (separate file in
`app/api/fortnox/extract-worker/route.ts`) emits a different shape — typed
in `lib/fortnox/validators.ts:73-94`:

```ts
interface ExtractionForValidation {
  doc_type?:            'pnl_monthly' | 'pnl_annual' | 'pnl_multi_month'
  organisation_number?: string | null
  company_name?:        string | null
  scale_detected?:      'sek' | 'ksek' | 'msek'
  periods: Array<{
    year: number
    month: number   // 0 for annual rollup
    rollup: {
      revenue?: number; food_cost?: number; alcohol_cost?: number;
      staff_cost?: number; other_cost?: number; depreciation?: number;
      financial?: number; net_profit?: number;
    }
    lines?: Array<{ amount?: number; account?: number }>
  }>
}
```

Plus revenue subset fields (`dine_in_revenue`, `takeaway_revenue`,
`alcohol_revenue`) added to `rollup` by `sql/M029` workflow.

### 3.4 Server-side validation checks

Two layers run in `app/api/fortnox/apply/route.ts:107-118` BEFORE any
`tracker_data` write (CLAUDE.md memory `feedback_fortnox_apply_guardrails`):

**Rule-based** (`lib/fortnox/validators.ts:123-134`, all in order — first findings array returned to caller):

| Check fn | Code(s) | Severity |
|---|---|---|
| `checkOrgNumberMatch` | `org_nr_mismatch` (error, NEVER overridable), `org_nr_missing_in_pdf` (info), `org_nr_not_set_locally` (warning) |
| `checkCompanyNameMatch` | `company_name_mismatch` (warning) |
| `checkPeriodMatch` | `period_mismatch` (error, NEVER overridable) |
| `checkPeriodInReasonableRange` | `period_year_out_of_range`, `period_month_out_of_range` (errors) |
| `checkDocTypeVsClaimedPeriod` | `multi_month_but_claimed_single` (warning) |
| `checkSignConvention` | `negative_value`, `net_profit_exceeds_revenue` (errors) |
| `checkMathConsistency` | `math_inconsistency` (warning, ±5 SEK tolerance) |
| `checkScaleAnomaly` | `scale_anomaly` (warning, ±50 % vs 6-month median) |
| `checkPeriodGap` | `period_gap` (info) |
| `checkSubsetCaps` | `revenue_subset_exceeds_total` (error), `revenue_subsets_sum_exceeds_total` (warning) |
| `validator_threw` | catch-all when a check raises (warning) |

**AI auditor** (`lib/fortnox/ai-auditor.ts`, called in parallel):
Haiku second-opinion. Failure is non-blocking (returns `'unavailable'`).

For the **supplier-invoice extractor**, the in-file validators in
`lib/inventory/pdf-extractor.ts` are independent:

- `no_rows` / `no_usable_rows` (block) — Claude returned zero
- `row_empty_description` (warn) — drops the row
- `total_mismatch` (block) — extracted total vs Fortnox header > 2 %
  tolerance. Has TWO rescue paths first:
  - `credit_note_sign_flipped` (warn) — abs match within 5 %, signs flipped
  - `self_invoice_sign_flipped` / `self_invoice_vat_skip` (warn) —
    inc-VAT vs ex-VAT match (`Quatra` oil recycling pattern, lines 261-336)
  - `rebill_loose_tolerance` (warn) — 15 % tolerance when every row matches
    the `[Supplier] [InvoiceNumber]` rebill pattern (lines 364-374)
- `no_header_total` (warn)
- `unusual_vat` (warn) — VAT rate outside {0, 6, 12, 25}
- `escalated_to_sonnet` (warn) — Haiku→Sonnet escalation reason
- `pdf_too_large` / `pdf_fetch_failed` / `claude_call_failed` / `rpc_failed`
  (block) — fail paths

### 3.5 Idempotency / duplicates

**Resultatrapport uploads** (`fortnox_uploads`):
- Per CLAUDE.md Session 13 + 14 invariants and `M032-FORTNOX-SUPERSEDE-CHAIN.sql`:
  re-uploading a corrected PDF for the same period marks the old upload
  `status='superseded'`. `fortnox_supersede_links(child_id, parent_id, year,
  month)` is the source of truth for the chain; `fortnox_uploads.supersedes_id`
  / `superseded_by_id` columns kept for backwards compat.
- `tracker_data` upsert `onConflict: 'business_id,period_year,period_month'`
  via `archive/migrations/supabase_schema.sql:131 UNIQUE(business_id,
  period_year, period_month)`.
- `tracker_line_items` cleared by `source_upload_id` on re-apply.

**Supplier invoices** (`supplier_invoice_lines`):
- `UNIQUE (business_id, fortnox_invoice_number, row_number)` —
  `sql/M075-INVENTORY-CATALOGUE.sql:198`. Re-runs of the backfill are
  no-ops via `ON CONFLICT DO NOTHING`.
- `fortnox_supplier_invoices` (M098 cache) — `UNIQUE(business_id, given_number)`
  for `.upsert({ onConflict: 'business_id,given_number' })`.
- `invoice_pdf_extractions` — `UNIQUE(business_id, fortnox_invoice_number)`
  (M078:78). One job row per (business, invoice).

**Stripe webhook idempotency** (M103, applied 2026-05-25): two-phase
claim via `claim_stripe_event` / `mark_stripe_event_processed` RPCs.

**Resend email idempotency**: every `sendEmail` carries an `Idempotency-Key`
header (CLAUDE.md Session 21 invariants L18) — auto-sha1 derived if not
explicitly passed.

---

## 4. Categorization (current) — the thing being replaced

### 4.1 How line items categorize today (supplier invoices)

Pipeline: `lib/inventory/matcher.ts::matchInvoiceLine` (the 5-step matching
ladder from `INVENTORY-CATALOGUE-PLAN.md`):

```
Gate 0 — IS this line inventory at all?  Three passes, first wins:
  (a) supplier_classifications override (M083, per-business owner override
      → 'not_inventory' short-circuit)
  (b) categoryForBasAccount(account_number)  →  food/beverage/alcohol/
      cleaning/takeaway_material/disposables/other  (BAS routing, see below)
  (c) categoryForSupplier(supplier_name)  →  fallback when account_number
      is NULL (Chicce's 2026-05-21 backfill had 100 % NULL accounts)
  Result null OR 'not_inventory' OR 'other' → match_status='not_inventory'.

Step 1 — exact (supplier_fortnox_number, article_number) → product_aliases hit
Step 2 — exact (supplier, normalised_description, unit) → product_aliases hit
Step 3 — trigram > 0.80 within same supplier → auto-link + insert new alias
Step 4 — trigram > 0.85 across suppliers → auto-link + insert new alias
Step 5 — queue for owner review (match_status='needs_review')
```

`lib/inventory/normalise.ts` is the bedrock function: lowercase, fold åäö→aao,
strip punctuation, collapse "5 kg"→"5kg". Changing it without a
re-normalisation migration silently corrupts the unique index on
`(business_id, supplier_fortnox_number, normalised_description, unit)`.

The "other / unresolved bucket" IS the `needs_review` queue:
`supplier_invoice_lines.match_status = 'needs_review'` with NULL
`product_alias_id`. Browsed via:
- `/api/inventory/needs-review` (`app/api/inventory/needs-review/`) — groups
  by (supplier, normalised_desc, unit), surfaces in
  `app/inventory/review/page.tsx`.
- `/api/inventory/review/ai-suggest` (`app/api/inventory/review/ai-suggest/route.ts`) —
  Haiku-backed bulk-review agent. Suggestions cached for 24 h in
  `inventory_review_suggestions` (M099).
- `/api/inventory/review/learn` (`app/api/inventory/review/learn/route.ts`) —
  records owner agreement/override in `inventory_review_outcomes` (M099).

### 4.2 When a human re-sorts an item, WHERE is the correction written?

Multiple persistence layers:

1. **Owner picks an existing product for a needs_review group:**
   `createProductFromLine()` in `lib/inventory/matcher.ts:415-498` inserts a
   new `product_aliases` row with `match_method='owner_confirmed'`,
   `match_confidence=NULL`. The matcher's Steps 1+2 will catch the same
   spelling instantly next time.

2. **Owner edits product fields (name, category, pack_size, base_unit, unit, etc.):**
   PATCH `/api/inventory/items/[id]` writes back to `products` table.
   Surfaced from `app/inventory/items/[id]/page.tsx` header and from the
   `/inventory/recipes` drawer inline "✎ edit product" expand (CLAUDE.md
   Session 20 invariants L154).

3. **Owner edits a specific line:** PATCH `/api/inventory/lines/[id]` writes
   back to `supplier_invoice_lines.{quantity, unit, price_per_unit, total,
   currency}`. Note `supplier_invoice_lines.source` is tagged
   `'owner_correction'` when this fires (per `sql/M078:30-31` comment).

4. **Owner skips a whole supplier:** "Skip ALL from supplier" button writes
   a row to `supplier_classifications(business_id, supplier_fortnox_number,
   classification='not_inventory')` (M083). Future invoices from that
   supplier never enter the review queue.

5. **Skipped suppliers admin / restore:** `/inventory/skipped` page;
   DELETE via `app/api/inventory/skipped-suppliers/`.

6. **AI suggestion outcomes:** when owner accepts/rejects an AI suggestion,
   `inventory_review_outcomes` records (ai_action, ai_confidence,
   owner_action, agreed) — used by next AI call as in-context examples
   ('Recent owner corrections — learn from these'), per `M099` comments.

7. **For the Resultatrapport (P&L) path:** rule-based classifier in
   `lib/fortnox/classify.ts` is hardcoded; there's no per-org override.
   `archive/migrations/M030-RECATEGORIZE-LINE-ITEMS.sql` was a one-off
   bulk re-tag. The cron `/api/cron/recategorise-other` (vercel.json:36)
   re-classifies `tracker_line_items` rows where `subcategory='other'`
   nightly; no learning loop.

### 4.3 Existing alias / supplier / learning tables

- `product_aliases` — exists and is core (M075). Two partial unique indexes
  prevent duplicates structurally (`article_number IS NOT NULL` path and
  `article_number IS NULL` path with COALESCE on unit). PostgREST `.upsert`
  can't drive these — `lib/inventory/matcher.ts:315-394` uses SELECT-then-
  INSERT with 23505 re-SELECT (CLAUDE.md memory
  `feedback_postgrest_upsert_partial_indexes`).
- `supplier_classifications` — per-business owner overrides (M083).
- `inventory_review_outcomes` — agent learning loop (M099).
- `supplier_mappings` (referenced in
  `app/api/integrations/fortnox/route.ts:574-580`) — keyword→category rules
  per org. Not defined in any migration file I read; **not found** as a
  table-creation SQL in `sql/` or `archive/migrations/`. May be a pre-existing
  prod table or dead code; the legacy sync function reads it. Either way
  it's NOT the canonical learning path — the inventory pipeline (M075+)
  uses `product_aliases` + `inventory_review_outcomes`.
- **No supplier master / supplier_name normalisation table.** Suppliers are
  identified by Fortnox `SupplierNumber` (TEXT) directly per `M075` comment
  L13-15. Names are denormalised snapshots (`supplier_name_snapshot`) on
  every line / alias / classification row.

### 4.4 Category taxonomy

**Hardcoded, shared across all tenants.** Two distinct taxonomies:

- **Inventory products** — `lib/inventory/categories.ts` defines the closed
  enum: `'food' | 'beverage' | 'alcohol' | 'cleaning' | 'takeaway_material'
  | 'disposables' | 'other'`. Enforced by CHECK on `products.category`
  (M075:64-67). Per-tenant override on a per-row basis only via
  `products.category_overridden` flag.
- **P&L line items** — `lib/fortnox/classify.ts` has its own category enum:
  `'revenue' | 'food_cost' | 'staff_cost' | 'other_cost' | 'depreciation' |
  'financial'`. Sub-categories are free-text per `subcategory` column on
  `tracker_line_items`.

Neither taxonomy is per-tenant. The supplier-name dictionary in
`lib/inventory/suppliers.ts` is also shared across all tenants (a
hand-curated list of ~70 real Swedish suppliers).

---

## 5. Fortnox integration surface

### 5.1 What is actually pulled today

| Data | Endpoint | How | Cached |
|---|---|---|---|
| Vouchers (general ledger with VoucherRows) | `/3/vouchers/{series}/{number}` | `lib/fortnox/api/vouchers.ts` + `lib/fortnox/api/voucher-to-aggregator.ts` | `fortnox_vouchers_cache` (M080) keyed `(business, year, voucher_series, voucher_number)`. VoucherRows kept as JSONB. |
| Chart of accounts | `/3/accounts` | `lib/fortnox/api/accounts-list.ts` | Pull on demand; not in a dedicated cache table. |
| Financial years | `/3/financialyears` | `lib/fortnox/api/financial-years.ts` | Per-call. |
| Account balances | `/3/accounts/{n}` (variants) | `lib/fortnox/api/account-balance.ts` | Per-call. **CLAUDE.md memory `feedback_fortnox_balance_field_semantics`**: `BalanceBroughtForward` = opening, `BalanceCarriedForward` = current — don't sum YTD on top. |
| Supplier invoices (list + detail) | `/3/supplierinvoices`, `/3/supplierinvoices/{n}` | Daily cron + lazy detail fetch in `lib/inventory/backfill-worker.ts` | `fortnox_supplier_invoices` (M098, **pending**) |
| Sales invoices | `/3/invoices` | `app/api/integrations/fortnox/route.ts:553` legacy sync | None |
| Resultatrapport PDFs | (file upload only — not pulled from Fortnox; owner uploads from accountant) | `app/api/fortnox/upload/route.ts` | Bucket `fortnox-pdfs` |
| Invoice attachments (PDFs) | `/3/inbox/{file_id}` → fallback `/3/archive/{file_id}` | `lib/inventory/pdf-extractor.ts:577-589`, `app/api/integrations/fortnox/invoice-pdf/route.ts` | Not stored locally — proxied through. |
| Unpaid invoices | `/3/invoices?filter=unpaid` (or similar) | `lib/fortnox/api/unpaid-invoices.ts` | None |
| Company identity (legal_name, org_nr, city) | `/3/companyinformation` | `lib/fortnox/company-identity.ts` | Written to `businesses` columns |
| Cost-centre / department | scope `costcenter` | scope granted (route.ts:75) | **Not found** as an active pull — scope requested but no `lib/fortnox/api/cost-centers.ts`. |
| Customer / supplier master | scope `customer` / `supplier` | scopes granted | **Not found** as active pulls. |
| Time reporting + salary | scopes `timereporting` + `salary` | scopes granted | **Not found** — for future Lön activation. |
| Articles master | scope `article` | granted | **Not found** as a pull. |

### 5.2 BAS account + VAT per invoice LINE?

**Yes — but inconsistently populated by Fortnox.**

The schema captures it:
- `supplier_invoice_lines.account_number TEXT` — BAS account from
  `SupplierInvoiceRow.AccountNumber` (M075:178).
- `supplier_invoice_lines.vat_rate NUMERIC` (M075:176).
- `supplier_invoice_lines.currency TEXT` (M085, default 'SEK').

Reality (CLAUDE.md L107 + the comment in `lib/inventory/matcher.ts:84-86`):
**Chicce's 2026-05-21 backfill: 100 % of 3218 supplier-invoice-lines rows had
`account_number = NULL`.** Fortnox doesn't post the GL account back via the
`/supplierinvoices/{n}` detail endpoint until the invoice is bokförd — and
even then it's per-supplier-setup-dependent. That's why the matcher needs
the supplier-name fallback classifier (`lib/inventory/suppliers.ts`).

Voucher rows DO carry `Account` + `Debit` + `Credit` reliably
(`lib/fortnox/api/voucher-to-aggregator.ts:159`), so the voucher-cache
(M080) path captures BAS/VAT well — but it's only invoked for the
verifikationslista / R2 SIE / R3 paths in `/revisor`, not joined back to
supplier-invoice-lines.

### 5.3 Sync mechanism, cadence, credential storage

- **Mechanism:** Vercel cron (incremental daily fetch) + on-demand sync
  triggered from the OAuth callback. No webhooks from Fortnox.
- **Cadence:** see `vercel.json`. Notable Fortnox-touching crons:
  - `fortnox-backfill-worker` — daily `0 6 * * *`
  - `fortnox-supplier-sync` — daily `10 6 * * *`
  - `voucher-cache-refresh` — daily `15 6 * * *`
  - `inventory-lines-sync` — daily `30 6 * * *`
  - `inventory-pdf-extract-sweep` — every 30 min during 06-22 UTC
    (`0,30 6-22 * * *`)
  - `extraction-sweeper` — `*/2 * * * *`
  - `fx-rates-update` — daily `0 17 * * *`
- **OAuth flow:** `app/api/integrations/fortnox/route.ts` (well-commented).
  HMAC-signed state with `ADMIN_SECRET`, base64url (CLAUDE.md memory
  `feedback_fortnox_oauth_state_encoding`). Scopes granted (route.ts:69-88):
  `bookkeeping`, `invoice`, `supplierinvoice`, `salary`, `companyinformation`,
  `costcenter`, `customer`, `supplier`, `timereporting`, `article`,
  `archive`, `inbox`, `connectfile`. Note: `payments` + `settings` were
  temporarily removed 2026-05-10 due to "fortnox denied" on the second
  business connection (route.ts:84-87).
- **Token storage:** `integrations.credentials_enc` — AES-256-GCM
  encrypted JSON `{access_token, refresh_token, expires_at}` via
  `lib/integrations/encryption.ts`. Access tokens expire after 60 min;
  refresh handled by `lib/fortnox/api/auth.ts::getFreshFortnoxAccessToken`.
- **Refresh serialisation:** `acquire_fortnox_refresh_lock` /
  `release_fortnox_refresh_lock` RPCs (`sql/M096`) — DB-level lock so two
  parallel processes don't post the same refresh_token to Fortnox and
  invalidate the integration. Plus in-process dedup Map.
- **Per-token concurrency cap:** `lib/fortnox/api/fetch.ts` caps 2 in-flight
  per access token (CLAUDE.md Session 21 invariants L11).
- **Workspace deep link:** `integrations.fortnox_workspace_id` 32-hex
  string (M094) for `https://apps2.fortnox.se/app/{ws}/...` deep links.
  No API exposes this — owner pastes their Fortnox URL once.

---

## 6. Inventory & articles (current)

### 6.1 Tables for articles/inventory

**`products`** (`sql/M075-INVENTORY-CATALOGUE.sql:33-73` + extensions in
M087, M089, M090):

```
id UUID PK
org_id UUID NOT NULL → organisations  ON DELETE CASCADE
business_id UUID NOT NULL → businesses ON DELETE CASCADE
name TEXT NOT NULL                       -- owner-curated display name
category TEXT NOT NULL  CHECK IN ('food','beverage','alcohol','cleaning',
                                  'takeaway_material','disposables','other')
category_overridden BOOLEAN NOT NULL DEFAULT FALSE
count_unit TEXT                          -- Phase C; usually NULL today
invoice_unit TEXT                        -- most-common unit seen on invoices
unit_conversion NUMERIC                  -- Phase C; usually NULL today
default_supplier_fortnox_number TEXT     -- Fortnox SupplierNumber
default_supplier_name TEXT
created_via TEXT NOT NULL CHECK IN ('auto_exact','auto_fuzzy','owner_review',
                                    'manual','fortnox_backfill')
created_at, updated_at TIMESTAMPTZ
archived_at TIMESTAMPTZ                  -- soft delete
-- M087 additions:
pack_size NUMERIC                        -- base_units per invoice_unit
base_unit TEXT CHECK IN ('g','ml','st')
-- M089 addition:
source_recipe_id UUID → recipes(id) ON DELETE SET NULL
-- M090 additions:
price_override NUMERIC                   -- per invoice_unit
price_override_currency TEXT CHECK IN ('SEK','EUR','USD','NOK','DKK','GBP')
price_override_set_at TIMESTAMPTZ
UNIQUE(business_id, name)
```

**`product_aliases`** (M075:89-141, with two partial unique indexes
covering article_number paths):
```
id UUID PK, product_id FK, business_id FK,
supplier_fortnox_number TEXT NOT NULL, supplier_name_snapshot TEXT,
article_number TEXT,
raw_description TEXT NOT NULL,
normalised_description TEXT NOT NULL,
unit TEXT,
match_method TEXT CHECK IN ('article_number','description_exact',
                            'fuzzy_same_supplier','fuzzy_cross_supplier',
                            'owner_confirmed')
match_confidence NUMERIC,
first_seen_at, last_seen_at, seen_count
```

**`supplier_invoice_lines`** (M075:148-213, plus M078 `source`, M085 `currency`):
```
id UUID PK, org_id FK, business_id FK,
supplier_fortnox_number TEXT NOT NULL, supplier_name_snapshot TEXT,
fortnox_invoice_number TEXT NOT NULL, invoice_date DATE NOT NULL,
invoice_period_year INTEGER NOT NULL, invoice_period_month INTEGER NOT NULL,
row_number INTEGER NOT NULL,
raw_description TEXT NOT NULL, article_number TEXT,
quantity NUMERIC, unit TEXT, price_per_unit NUMERIC,
total_excl_vat NUMERIC NOT NULL, vat_rate NUMERIC, account_number TEXT,
product_alias_id UUID → product_aliases(id) ON DELETE SET NULL,
match_status TEXT CHECK IN ('matched','needs_review','skipped','not_inventory'),
match_candidates JSONB,
created_at, matched_at,
-- M078:
source TEXT NOT NULL DEFAULT 'fortnox_row'
       -- ∈ {fortnox_row, pdf_extraction, owner_correction}
-- M085:
currency TEXT NOT NULL DEFAULT 'SEK'
         CHECK IN ('SEK','EUR','USD','NOK','DKK','GBP')
UNIQUE (business_id, fortnox_invoice_number, row_number)
```

**`fortnox_supplier_invoices`** (M098 cache, **pending application**):
header-level cache, see §5.1.

**Stock tables** (M091/M092/M093):
- `stock_locations` — optional per-business count locations
- `stock_counts` + `stock_count_lines` — point-in-time stocktake snapshots
  with **immutable price-at-count snapshots** for re-open consistency.
- `waste_log` — manual waste events with `reason` ∈
  `{spoilage, spill, over_portion, staff_meal, comp, other}`.

**POS / sales** (M097, **pending application**):
- `pos_menu_items(id, org_id, business_id, pos_provider CHECK IN (manual,
  caspeco, onslip, bonebar, inzii, personalkollen, other), pos_item_id,
  name, recipe_id → recipes, price_inc_vat, archived_at, …)`
- `pos_sales(id, org_id, business_id, pos_item_id → pos_menu_items, sold_at,
  sold_date GENERATED, quantity, net_revenue, source, source_ref, …)`
- Used by `lib/inventory/variance.ts::computeVariance` to compute
  theoretical (POS sales × recipes) vs actual (purchases + waste) draw.

### 6.2 Unit normalisation

**Yes, fully implemented.** `lib/inventory/unit-conversion.ts`:

- `canonicalUnit(raw)` normalises `'kg'/'kilo'/'kilogram'` → `'kg'`,
  `'styck'/'stk'/'pcs'/'piece'` → `'st'`, etc.
- Three families: `mass` (g/kg/hg base=g), `volume` (ml/cl/dl/l base=ml),
  `count` (st base=st).
- `convertQuantity(qty, from, to)` returns null on cross-family —
  caller surfaces `unit_mismatch=true` warning.
- `parseProductPackSize(name)` auto-detects pack size from product name
  via regex `/(\d+(?:[.,]\d+)?)\s*(kg|hg|g|l|dl|cl|ml|st|frp|fp|pack|paket)\b/gi`
  (line 92). Used as fallback when `products.pack_size` is null
  (`lib/inventory/recipe-cost.ts:186-194`).
- Mass↔volume not supported (would need per-product density).

### 6.3 Suppliers — identification & multi-legal-entity

- **Identifier:** Fortnox `SupplierNumber` (TEXT) — denormalised onto
  every `product_aliases` + `supplier_invoice_lines` + `supplier_classifications`
  + `fortnox_supplier_invoices` row.
- **No local `suppliers` table** — deliberate per M075 deviation note
  L13-15: "Suppliers are identified by Fortnox `SupplierNumber` (TEXT)
  directly. Name is captured as a denormalised snapshot per line so the
  UI doesn't have to join out to a live Fortnox fetch for display."
- **Org-nr per supplier:** **Not stored anywhere on our side.** Fortnox's
  `Supplier` record (the master via `/3/suppliers/{id}`) carries
  `OrganisationNumber` but we never pull suppliers master data into our DB.
- **Multiple legal entities per supplier name:** **Not handled.**
  `EXACT_OVERRIDES` in `lib/inventory/suppliers.ts:54-126` has examples
  like `'carlsberg sverige aktiebolag'` (alcohol) vs `'carlsberg intrum'`
  (debt collector for Carlsberg) — handled by **separate dictionary
  entries**, not a "Carlsberg group" abstraction.

### 6.4 Current cost / price sourcing

`lib/inventory/recipe-cost.ts::getProductLatestPrices` is the single
reader for "what's this product cost right now in SEK". Order of
precedence:

1. **`products.price_override`** (manual, M090) — wins over everything;
   FX-converted at "today" via `fxIndex` if non-SEK.
2. **`products.source_recipe_id`** (recipe-promoted product, M089) —
   `latest_price = recipe.food_cost / recipe.portions` (live recompute).
3. **Latest `supplier_invoice_lines.price_per_unit`** for the product,
   filtered by `match_status='matched'`, sorted `invoice_date DESC`.
   FX-converted via `lib/inventory/fx.ts::getFxRate` at the line's
   `invoice_date` (or null if no FX rate available — line treated as
   missing-price, per CLAUDE.md L162 memory `feedback_llm_adjust_layer`).
4. Cost-per-base-unit = `latest_price / pack_size` (M087). When
   `pack_size` is null, fall back to `parseProductPackSize(name)`. When
   that also fails, legacy 1:1 + `unit_mismatch=true` flag.

No moving-average; no weighted price. **Always "latest invoice"
unless overridden.** That's a deliberate choice per the recipe-cost.ts
header comment.

---

## 7. Recipes (current)

### 7.1 Recipe structure

`sql/M084-RECIPES.sql:23-39`:

```sql
recipes (
  id UUID PK, business_id FK, org_id FK,
  name TEXT NOT NULL, type TEXT,    -- starter/main/pasta/pizza/dessert/drink/cocktail/side/sauce/other (free-text)
  menu_price NUMERIC,               -- SEK incl VAT
  portions INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  archived_at, created_at, updated_at,
  UNIQUE (business_id, name)
)

recipe_ingredients (
  id UUID PK,
  recipe_id FK → recipes ON DELETE CASCADE,
  product_id FK → products ON DELETE RESTRICT,        -- M084 had NOT NULL; M086 drops that
  subrecipe_id UUID FK → recipes ON DELETE RESTRICT,   -- M086 addition
  quantity NUMERIC CHECK > 0, unit TEXT,
  notes TEXT, position INTEGER,
  CHECK exactly-one-of (product_id, subrecipe_id)      -- M086
  CHECK subrecipe_id != recipe_id                       -- M086 (cheap cycle guard)
)
```

Two partial unique indexes (M086):
- `(recipe_id, product_id) WHERE product_id IS NOT NULL`
- `(recipe_id, subrecipe_id) WHERE subrecipe_id IS NOT NULL`

### 7.2 Sub-recipes (recipes inside recipes)

**Yes — first-class.** `sql/M086-SUBRECIPES.sql`:
- `recipe_ingredients.subrecipe_id` with exactly-one-of CHECK.
- DB-level self-reference CHECK (`subrecipe_id != recipe_id`).
- Cycle prevention also in API (`POST /api/inventory/recipes/[id]/ingredients`
  calls `wouldCreateCycle()` in `lib/inventory/recipe-cost.ts:308-328`) and
  in cost-compute (ancestor-stack guard in
  `recipe-cost.ts::computeRecipeCost:90-120`) — three-layer defence.
- Cost model: sub-recipe yield = `recipes.portions`; ingredient
  quantity is in portions of the sub-recipe.

### 7.3 Waste %, sell price, VAT, versioning

| Feature | Present | Notes |
|---|---|---|
| Waste % per recipe line | **Not found** | No `waste_pct` / `yield_pct` column on `recipe_ingredients`. `waste_log` is a separate per-event log, not a per-recipe parameter. |
| Selling price | **Yes** | `recipes.menu_price` NUMERIC, owner-entered, comment says "SEK incl VAT". |
| Margin / GP | **Yes** (derived) | `lib/inventory/recipe-cost.ts:243-249` returns `food_pct`, `gp_kr`, `gp_pct` when `menu_price > 0`. |
| VAT on sell price | **Not stored** | `menu_price` is documented as incl-VAT but there's no `vat_rate` column on `recipes`. The cost calc ignores VAT entirely. |
| Recipe versioning / snapshot | **Not found** | Single `updated_at` only. No `recipe_versions` table; no "frozen recipe at point in time" capability. Cost is always live-recomputed from current latest prices. |
| Franchise/location variant (master + per-location) | **Not found** | Recipes are scoped to one `business_id`. No `master_recipe_id` / `inherited_from`. Each location has its own copy. |
| Promote recipe → catalogue product (for stocktake) | **Yes** | M089: `products.source_recipe_id`. Lets a prep recipe (tomato sauce) appear in catalogue + ingredient picker + stock counts. |

### 7.4 Recipe cost computation

Single source of truth: `lib/inventory/recipe-cost.ts::computeRecipeCost`.

- Returns `RecipeCostSummary { food_cost, ingredients[], missing_prices,
  unit_mismatches, food_pct, gp_pct, gp_kr }`.
- For each ingredient: pack-aware conversion (recipe qty in g/ml →
  `cost_per_base_unit = unit_price / pack_size`); fallback to legacy 1:1
  with `unit_mismatch=true` warning when pack data missing.
- Sub-recipes recurse via `loadRecipeIndex(db, businessId)` (the full
  business → Map of id → ingredients) + `Set<string>` ancestor stack
  for cycle detection.

---

## 8. Tax / VAT / currency (current)

### 8.1 VAT rates per line — storage

- `supplier_invoice_lines.vat_rate NUMERIC` (M075:176). Validator
  emits `unusual_vat` warning if outside `{0, 6, 12, 25}`
  (`pdf-extractor.ts:397-405`).
- `tracker_data` has aggregate revenue subset columns
  `dine_in_revenue`, `takeaway_revenue`, `alcohol_revenue` (M029,
  added by `archive/migrations/M029-REVENUE-VAT-SPLIT.sql:28-31`).
- `tracker_line_items.subcategory` carries VAT-derived classification
  for revenue rows (`food`/`takeaway`/`alcohol` from VAT %).
- `fortnox_supplier_invoices.vat` NUMERIC at the invoice header
  level (M098).
- `fortnox_supplier_invoices.currency` TEXT (M098).

### 8.2 Hard-coded VAT rates — every location flagged

`grep` for `\b6\b`/`\b12\b`/`0.06`/`0.12`/etc. across `lib/` produced
the following genuine VAT-rate hard-codes:

| File:line | Code | Note |
|---|---|---|
| `lib/fortnox/classify.ts:121-124` | `/\b25\s*%?\s*moms\b/`, `/\b12\s*%?\s*moms\b/`, `/\b6\s*%?\s*moms\b/` | Pattern-matching Swedish labels — `25%→alcohol`, `12%→food` (dine-in), `6%→takeaway`. Plus platform names (wolt/foodora/uber eats) → takeaway. |
| `lib/pos/personalkollen.ts:307-309` | `Math.abs(vat - 0.12) < 0.001` → dineIn / `0.06` → takeaway / `0.25` → alcohol | POS line classifier. |
| `lib/pos/personalkollen.ts:260` | Comment documenting "0.06, 0.12, 0.25" | Documentation only. |
| `lib/revisor/momsrapport.ts:28-30, 174-176, 375-377` | `Box 10 / 0.25`, `Box 11 / 0.12`, `Box 12 / 0.06` | Implied-sales reverse-calc for Swedish Momsrapport. |
| `lib/inventory/pdf-extractor.ts:310-336` | `for (const vatRate of [25, 12, 6])` | Self-invoice rescue trial-and-error gross-up loop. |
| `lib/inventory/pdf-extractor.ts:399` | `[0, 6, 12, 25].includes(v)` | "Unusual VAT" warning check. |
| `lib/fortnox/validators.ts:259-263` | (no rate numbers directly, but uses food/staff/alcohol categories) | Sign-convention checks. |
| `lib/inventory/pdf-extractor.ts` SYSTEM_PROMPT L632-715 | Prompts Claude with "25/12/6" repeatedly | Hard-coded instruction text. |
| `archive/migrations/M029-REVENUE-VAT-SPLIT.sql` | `'\m6\s*%\s*moms\M'`, `\m12`, `\m25` | One-off backfill regex. |

**Implication for the temporary 6 % food rate:** the system currently
treats `6 %` as "takeaway" everywhere (Wolt / Foodora bucket). If
Swedish dine-in food temporarily moves to 6 %, **every classifier above
would silently mis-bucket dine-in as takeaway**.

There's also a literal `vat_rate IN (0, 6, 12, 25)` validator. No central
"valid Swedish VAT rates" constant — each call-site repeats the list.

### 8.3 BAS account codes on lines

- **Yes:** `supplier_invoice_lines.account_number TEXT` (M075:178) — populated
  on supplier invoices when Fortnox returns it (often NULL for unbokförda
  invoices, see §5.2).
- **Yes:** `tracker_line_items.account` (implied — referenced by
  `archive/migrations/M028-FORTNOX-PROPER-FIX.sql:126`). I did not see the
  exact CREATE TABLE for `tracker_line_items` in `sql/` or
  `archive/migrations/` — it was referenced as already-existing. Schema details:
  **Not found** (confirm via `pg_columns`).
- **Yes:** `fortnox_vouchers_cache.rows JSONB` contains the per-row
  `Account / Debit / Credit / TransactionInformation`.

BAS routing tables:
- `lib/inventory/categories.ts::SPECIFIC_OVERRIDES` (40xx + 5xxx allowlist
  for inventory).
- `lib/fortnox/classify.ts::classifyByAccount` (P&L-level: 3xxx revenue,
  4xxx food_cost, 5000-6999 other_cost, 7000-7799 + 7900-7999 staff_cost,
  7800-7899 depreciation, 8xxx financial).
- `app/api/integrations/fortnox/route.ts:586-597` `ACCOUNT_CATS` —
  legacy sync's own BAS map. **This duplicates the canonical classifier
  and is at risk of drift.** Marked as legacy (route.ts L546-560 sync
  function).

### 8.4 Multi-currency

- `supplier_invoice_lines.currency` (M085) — default SEK, CHECK
  `IN ('SEK','EUR','USD','NOK','DKK','GBP')`.
- `products.price_override_currency` (M090) — same enum.
- `fortnox_supplier_invoices.currency` (M098).
- `fx_rates` table (M088, **pending application**) — daily ECB rates
  keyed `(rate_date, currency, source)` with `rate_to_sek` NUMERIC.
- `lib/inventory/fx.ts` — `loadFxIndex` / `getFxRate(currency, date, idx)`
  / `toSek(amount, currency, date, idx)`. At-or-before lookup; falls
  back to most recent available rate.
- Daily cron `/api/cron/fx-rates-update` (vercel.json:28, `0 17 * * *`)
  ingests from ECB XML.
- Per CLAUDE.md L162: when non-SEK + no FX rate available, cost reader
  returns `latest_price_sek = null` and treats as missing-price rather
  than silently using native currency (avoids 11× / 10× error).

---

## 9. Background jobs & scheduling

### 9.1 Mechanisms in use

- **Vercel Cron** is the primary scheduler. 35 entries in
  `vercel.json:2-37`. Cadences include sub-daily (`*/2 * * * *`,
  `*/30 * * * *`, `0,30 6-22 * * *`) — Pro plan enables these.
- **`pg_cron`** runs inside Supabase. From `archive/migrations/M021-PG-CRON-EXTRACTION-SWEEPER.sql`
  (per CLAUDE.md memory `project_arch_phase1_shipped`): a 20-second
  extraction worker + 1-minute stale-release timer for `extraction_jobs`.
  Plus the bookkeeping cleanups in `archive/migrations/supabase_schema.sql:525-535`
  (BankID sessions every 10 min, AI logs daily, auth events weekly).
- **`waitUntil` (Vercel)** — fire-and-forget background work after
  the response returns. Used by `app/api/integrations/fortnox/route.ts`
  (post-OAuth side-effects: identity sync, voucher cache warm,
  weather backfill, inventory backfill kick) and by
  `lib/inventory/backfill-worker.ts` for self-chaining hops.
- **Self-chaining workers** (CLAUDE.md memory
  `feedback_inventory_backfill_self_chain`): the inventory backfill
  checkpoints `cursor` to `inventory_backfill_state.progress` and
  re-launches itself before the Vercel maxDuration deadline. 30 hops
  ceiling (`MAX_RESUMES`, `backfill-worker.ts:32`).
- **Queue-style pattern:** `extraction_jobs` + dispatcher/worker/sweeper
  per `archive/migrations/FORTNOX-JOBS-MIGRATION.sql`. CLAUDE.md memory
  `feedback_architecture_patterns` lists "dispatcher→worker→sweeper"
  as canonical.

### 9.2 Jobs that run today (vercel.json)

Full list (file is canonical; copying to avoid paraphrase risk):

```
master-sync                       0 4 * * *
events-sync                       15 4 * * *
reviews-sync                      20 4 * * *
anomaly-check                     30 4 * * *
health-check                      0 5 * * *
data-source-disagreements-alert   30 5 * * *
manual-tracker-audit              45 5 * * *
fortnox-backfill-worker           0 6 * * *
fortnox-supplier-sync             10 6 * * *
scheduling-sync                   20 6 * * *
voucher-cache-refresh             15 6 * * *
inventory-lines-sync              30 6 * * *
inventory-pdf-extract-sweep       0,30 6-22 * * *
weekly-digest                     30 6 * * 1
cost-intelligence                 30 6 2 * *
setup-health-refresh              0 7 * * *
ai-accuracy-reconciler            0 7 * * *
onboarding-success                30 7 * * *
ai-daily-report                   0 8 * * *
scheduling-optimization           30 8 * * 1
customer-health-scoring           0 9 * * 1
invoice-reconciliation            0 9 * * 0
supplier-price-creep              30 9 1 * *
daily-forecast-reconciler         0 10 * * *
today-data-sentinel               0 14 * * *
fx-rates-update                   0 17 * * *
integration-health-watchdog       */30 * * * *
catchup-sync                      5 6-23 * * *
extraction-sweeper                */2 * * * *
api-discovery                     0 2 * * 0
api-discovery-enhanced            30 2 * * 0
industry-benchmarks               0 3 * * 0
ai-log-retention                  30 3 * * 0
recategorise-other                45 3 * * *
```

Plus `app/api/cron/` includes more handlers NOT in `vercel.json` (the dir
listing has 49 dirs vs 35 cron entries) — those are kicked manually or
from other server code rather than scheduled.

### 9.3 Embeddings / vector usage

- `archive/migrations/supabase_schema.sql:11-13` enables `vector`
  (pgvector) extension.
- `document_chunks` table (supabase_schema.sql:177-202) has
  `embedding vector(1536)` column with an `ivfflat` index. Comment says
  "OpenAI/Anthropic embedding (optional)".
- `document_chunks.tf_idf_terms JSONB` — pre-computed TF-IDF for fast
  retrieval.
- Full-text-search index `idx_chunks_fts USING gin(to_tsvector('swedish', text))`.
- **Active usage:** `lib/documents/chunker.ts` + `lib/documents/extractor.ts`
  exist and the schema is in place. I did NOT verify whether the embedding
  column is actually being populated today (would require a DB query).
  From CLAUDE.md and the lib structure, the documents/notebook area
  has not been the active development focus in 2026.

---

## 10. Photo capture, storage & mobile

### 10.1 Mobile / responsive surface

- **No native mobile app.** No React Native / Expo / Capacitor / iOS / Android
  files. The codebase is web-only.
- The web app is responsive (next-intl + Tailwind-less inline styles +
  the lavender/UX token system in `lib/constants/tokens.ts`). The
  inventory bulk-review and PDF-upload flows are designed for desktop;
  there's no dedicated mobile flow for waste capture / stocktake.
- `next.config.js:106` declares `Permissions-Policy: camera=(), microphone=(),
  geolocation=()` — currently denies camera, so photo capture from device
  camera is not enabled.

### 10.2 Photo / file upload

Active upload surfaces:
- **Fortnox Resultatrapport PDF upload** —
  `app/api/fortnox/upload/route.ts:134` writes to bucket `fortnox-pdfs`.
- **Notebook documents** — `app/api/invoices/extract/route.ts:178` and
  `app/api/invoices/route.ts:145` use bucket `documents`. Schema for
  buckets in `archive/migrations/supabase_schema.sql:558-572`:

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('documents', 'documents', false, 52428800,        -- 50 MB
   ARRAY['application/pdf', '...docx', '...xlsx', 'text/csv', 'text/plain',
         'image/jpeg', 'image/png', 'image/webp']),
  ('reports',   'reports',   false, 10485760, ['application/pdf', '...docx', '...xlsx'])
```

- **Bucket `fortnox-pdfs`** — referenced from `app/api/fortnox/upload/route.ts`
  but its `storage.buckets` INSERT is **not in** `supabase_schema.sql`. Likely
  created via Supabase UI or a later (archived) migration; details
  **not found** in code. The bucket reads/writes work in production so it
  exists.

### 10.3 Storage region & access

- Supabase project URL: `https://llzmixkrysduztsvmfzi.supabase.co` (CLAUDE.md
  §3 — Frankfurt region per CLAUDE.md §4 architecture diagram).
- Storage RLS (supabase_schema.sql:575-585): both `documents` and `reports`
  buckets enforce `(storage.foldername(name))[1] = current_org_id()::text`
  — files are namespaced under the org ID prefix. **Note this uses
  `current_org_id()` (single-org) not `current_user_org_ids()` (array).**
  Multi-org users may not see all their orgs' storage. Tracked as a known
  drift between the storage layer and the array-aware DB policies.

### 10.4 Image handling code

`next.config.js:71-77` allowlists `*.supabase.co/storage/v1/object/public/**`
for Next/Image. CSP `img-src` allows `data: blob: https://*.supabase.co`.
No image-resize / -optimize pipeline beyond Next/Image's defaults.

---

## 11. Existing UI patterns to match

### 11.1 Review queue / alerts feed / approval workflow

Existing review surfaces — reuse these patterns rather than reinventing:

| Surface | Path | Pattern |
|---|---|---|
| **Inventory bulk review** | `app/inventory/review/page.tsx` + `app/api/inventory/needs-review/`, `app/api/inventory/review/ai-suggest/`, `app/api/inventory/review/learn/` | Group-by-(supplier, normalised_desc, unit); AI suggestion cached 24h in `inventory_review_suggestions`; outcome captured in `inventory_review_outcomes` for the learning loop. |
| **Extraction review** | `app/inventory/extractions/page.tsx` + `app/inventory/extractions/[id]/page.tsx` | Per-PDF needs_review queue when validators block. Edit-grid then re-apply. |
| **Overheads review** | `app/overheads/review/page.tsx` + `app/api/overheads/...` | Owner-facing cost-flag triage. Drill-down to invoice via `/api/integrations/fortnox/drilldown` (CLAUDE.md Session 17 invariants). |
| **Anomaly alerts** | `app/alerts/page.tsx` (anomaly_alerts table + M053 confirmation workflow with `confirmation_status` ∈ `{pending, confirmed, rejected, auto_resolved}`) | Confirm/reject workflow feeds back to the prediction system. |
| **Fortnox apply** | `app/api/fortnox/apply/route.ts` | Validators return findings; UI surfaces them; owner acks via `acknowledged_warnings: string[]` + `force: true`. Override-allowed flag per finding. |
| **Skipped suppliers** | `/inventory/skipped` (admin restore view) | Soft-skip pattern. |
| **AppShell gates** | `components/AppShell.tsx` | OnboardingGate then PlanGate (load-bearing order per CLAUDE.md L138). |
| **Cross-customer banners** | `components/SyncProgressBanner` (referenced in CLAUDE.md memory `feedback_sync_banner_staleness`) | Staleness-gated (>15 min running = dead). |

### 11.2 Design tokens

CLAUDE.md L29 confirms the token convention. Authoritative file:
**`lib/constants/tokens.ts`** which exports two systems:

- `UX` — legacy system (greys, navy/indigo, semantic green/amber/red).
  Used by un-migrated surfaces.
- `UXP` — pastel-lavender redesign tokens (current default for new
  surfaces). Adds shadow/typography/motion tier (lines 60-83).
- `Z` — z-index scale: `sticky(10) / rail(20) / banner(50) / dropdown(100) /
  backdrop(199) / modal(200) / tooltip(300) / toast(400)` (lines 90-99).
  CLAUDE.md Session 21 invariants L29: must use `Z.*`, not raw numbers.

**No `lib/constants/colors.ts` file at that exact path** — checked.
There IS no separate `colors.ts`; the comment at `tokens.ts:11` says
"colors.ts" referring to the old design system, but tokens.ts is the
single live source. **`lib/constants/tokens.ts` confirmed** as the
design-tokens home.

Inline-style convention: per CLAUDE.md memory `feedback_no_emojis` —
**no emojis anywhere**. Use small uppercase text labels instead.
Components use inline `style={{ ... }}` referencing `UXP.*` / `UX.*`
tokens; minimal Tailwind. The repo has no Tailwind config file
(`tailwind.config.*` does not exist).

---

## 12. Known data-quality issues

### 12.1 `opening_days` not read by forecasters — PARTIALLY RESOLVED

Status update (different from the prompt's premise):
- `lib/forecast/daily.ts:278,301` and `lib/forecast/daily-v2.ts:34,74`
  DO read `businesses.opening_days` and short-circuit to
  `predicted_revenue=0` on closed weekdays. Model version comment at
  `lib/forecast/daily.ts:201` says `'consolidated_v1.5.0'` adds this
  on 2026-05-16.
- `lib/forecast/llm-adjust.ts:259,435` also surfaces a
  `business_closed_for_weekday` reason to the LLM adjustment layer.
- Other forecast surfaces (`hourly.ts`, `monthly.ts`, `recency.ts`) —
  **not verified** whether they read opening_days. Worth checking
  before any new forecast surface gets added.

### 12.2 `tracker_data` pre-M047 rows with null `created_via` — RESOLVED

- `sql/M052-TRACKER-CREATED-VIA-BACKFILL.sql` backfilled
  `created_via = 'manual_pre_m047'` for every NULL row. Sanity-check
  query in the migration. Should be zero NULL rows now. Confirm
  in prod with a quick SELECT before treating as fully resolved.

### 12.3 Other partial migrations / dangling columns I encountered

| Item | File | Risk |
|---|---|---|
| **M097, M098, M100, M104 listed pending in MIGRATIONS.md** | `MIGRATIONS.md` L48+ | Code in `lib/`/`app/` references these tables (`pos_menu_items`, `pos_sales`, `fortnox_supplier_invoices`, scheduling tables, review_insights_cache). If owner hasn't applied them, the corresponding endpoints 500. Verify before relying on them. |
| **`integrations` UNIQUE drift** | CLAUDE.md L93 + `archive/migrations/supabase_schema.sql:104` declares `UNIQUE(business_id, provider)`. M049 added non-partial `integrations_org_biz_provider_uniq`. The archived UNIQUE never landed in prod. | New `.upsert({ onConflict })` must target `org_id,business_id,provider`. |
| **`integrations.payments`/`settings` scopes removed** | `app/api/integrations/fortnox/route.ts:84-87` | Temporarily removed 2026-05-10 — Fortnox returned "denied" on second-business connection. To re-add: confirm exact scope identifier strings. |
| **`backfill_status` enum** | `sql/M050:46-47` + M061 (`paused`) | CHECK ∈ `{idle,pending,running,completed,failed}` + paused added later. CLAUDE.md memory `feedback_check_constraint_drift` warns about enum/CHECK drift; verify CHECK matches actual values written by workers. |
| **`anomaly_alerts.confirmation_status`** | `sql/M053` | Adds the column triple but the original `anomaly_alerts` CREATE TABLE not in `sql/` — assumed to exist. |
| **`vat_filing_cadence` on businesses** | referenced `app/api/integrations/fortnox/route.ts:298` | No CREATE column DDL visible in `sql/` or `archive/migrations/`. Either lives in a missing/unreviewed migration or in prod-only DDL. |
| **`tracker_line_items` schema** | Referenced everywhere; create-table DDL **not found** in `sql/` or `archive/migrations/`. M048 mirrors it via `LIKE source INCLUDING ALL`. | Schema for `tracker_line_items` is **not reproducible from the repo** — would need to query prod for definitive columns. |
| **`fortnox-pdfs` storage bucket** | Used by `app/api/fortnox/upload/route.ts:134` etc. | INSERT for this bucket **not found** in repo SQL. Exists in prod (functionally works) but not in source control. |
| **`@anthropic-ai/sdk` 0.24.x (Aug 2024)** | `package.json:14` | CLAUDE.md memory `feedback_anthropic_sdk_outdated`: predates GA prompt caching; silently drops `cache_control`; no AI surface reads `cache_read_input_tokens`. **All "prompt caching" claims in code today are unmeasured.** Direct `fetch()` is a workaround in newer call sites. |
| **`supplier_mappings` table** | Referenced `app/api/integrations/fortnox/route.ts:574` | No CREATE TABLE for it in repo SQL; either a pre-existing prod table or dead legacy reference. Not used by the canonical inventory matcher. |
| **Cron deprecation paths** | `vercel.json` lists `*/2`, `*/30`, `0,30 6-22 * * *` | These rely on Vercel Pro. CLAUDE.md memory `project_vercel_pro_live` confirms upgrade 2026-04-22 — fine, but a fallback to Hobby would silently disable these. |
| **`current_user_org_ids()` vs `current_org_id()`** | M018 `archive/migrations/`. Storage RLS in `archive/migrations/supabase_schema.sql:574-585` still uses single-org `current_org_id()` | Multi-org users could see only one org's storage. Not strictly a "partial migration" but a known consistency gap. |
| **CHECK constraint widening** | CLAUDE.md memory `feedback_check_constraint_drift` lists 3 incidents in 24h where enum/CHECK landed without code being updated, or vice versa | Any new enum value (e.g., a new `match_method` like 'ai_confirmed', or `match_status='ai_pending'`) MUST land DB CHECK + TypeScript in the same commit. |

---

## Surprises / risks / inconsistencies

1. **Two parallel ingestion paths for Fortnox supplier invoices.** The
   structured `/supplierinvoices/{n}` API path (`backfill-worker.ts`) AND
   the PDF-vision path (`pdf-extractor.ts`) BOTH write to
   `supplier_invoice_lines`. They're disambiguated by `source` column
   (`fortnox_row` vs `pdf_extraction`). When Fortnox's structured rows
   are empty (Chicce's case: 3218/3218 rows had blank
   `raw_description`), the PDF path is needed. The new design must
   pick one or build a clean "if API returned nothing useful, fall back
   to PDF" gate — they currently coexist but aren't formally orchestrated.

2. **`account_number` is unreliably populated by Fortnox.** Per the
   Chicce backfill: 100 % NULL. This means **BAS routing alone cannot
   classify supplier-invoice lines** — the supplier-name dictionary in
   `lib/inventory/suppliers.ts` is load-bearing today. Any new
   categorisation design that assumes BAS as primary signal will break
   on new customers whose Fortnox config doesn't post the GL account
   on supplier-invoice receipt.

3. **No supplier master table.** Suppliers are identified by Fortnox
   `SupplierNumber` (TEXT) + a denormalised `supplier_name_snapshot`
   on every line. Two consequences for the new design:
   - No way to ask "which supplier's invoices did we get in the
     last month" cheaply without a DISTINCT scan over `supplier_invoice_lines`.
   - No supplier org-nr is stored on our side, so cross-customer
     "same supplier in different orgs" matching can't use the org-nr
     as a stable key — names are heterogeneous.

4. **Multi-org storage RLS is single-org-aware.** `storage.foldername(name)[1]
   = current_org_id()` (which returns the FIRST org). A user in two orgs
   doesn't see all their orgs' uploads. Not a data leak (still org-scoped),
   but a usability surprise. The DB policies migrated to
   `current_user_org_ids()` arrays in M018; storage policies did not.

5. **VAT rates 25/12/6 are sprinkled as literals.** No single
   `lib/sweden/vat.ts` with `{ALCOHOL: 25, DINE_IN: 12, TAKEAWAY: 6}`
   constants. If Sweden's temporary 6 % food rate ever ships, every
   classifier in §8.2 needs updating individually. The system's
   "6 % means takeaway" assumption is hard-coded in regex form in
   `lib/fortnox/classify.ts:123`.

6. **`product_aliases` has TWO partial unique indexes that PostgREST
   `.upsert({ onConflict })` cannot drive.** Pattern: SELECT-then-INSERT
   with 23505-retry. The matcher does this correctly. Any NEW writer to
   `product_aliases` must follow the same pattern. Same trap for
   `recipe_ingredients` partial uniques (CLAUDE.md memory
   `feedback_postgrest_upsert_partial_indexes`).

7. **Cost is always "latest invoice price".** No moving average; no
   weighted-average cost; no FIFO. Recipes recompute on every render.
   Stock counts snapshot the price-at-count for immutability, but the
   "current value if I sold this today" is a re-derive against current
   live prices.

8. **`@anthropic-ai/sdk` is 16 months old (0.24.3, Aug 2024).**
   Predates GA prompt caching. Every "prompt caching" claim in code
   today is unmeasured. Some surfaces work around with direct `fetch()`
   (e.g. `pdf-extractor.ts`). New AI surfaces should also use direct
   `fetch()` or wait for an SDK upgrade.

9. **`archive/migrations/` mostly mirrors prod but with documented drift.**
   CLAUDE.md L235 explicitly tells you not to trust it. Schema for
   `tracker_line_items`, the `fortnox-pdfs` storage bucket, and
   `supplier_mappings` cannot be reproduced from the repo alone.

10. **Franchise/master-child recipes do not exist.** Every recipe is
    scoped to one `business_id`. For the planned "production logging /
    prep lists / waste trending" subsystems, if a single owner has 2+
    locations sharing a kitchen or sharing recipes, today they'd
    duplicate the recipes. Decide whether the new design needs a
    `master_recipe_id` / `inherited_from` column on `recipes` (cheap to
    add) or stays per-business.

---

## Questions I couldn't answer from the codebase

1. **Exact schema of `tracker_line_items`** — referenced everywhere,
   CREATE TABLE not in `sql/` or `archive/migrations/`. Need
   `\d+ tracker_line_items` from prod (or the original migration if it
   still exists outside this repo) to know columns / constraints / RLS.

2. **Whether M097 / M098 / M100 / M104 are actually applied in prod
   today.** `MIGRATIONS.md` says "pending application" but code that
   reads `pos_sales`, `fortnox_supplier_invoices`, scheduling tables,
   `review_insights_cache` is live. Either MIGRATIONS.md is stale, or
   those endpoints 500 today. A `pg_catalog.pg_tables WHERE schemaname='public'
   AND tablename IN (...)` query would confirm.

3. **`fortnox-pdfs` storage bucket policies + size limit** — the bucket
   exists in prod but its `storage.buckets` INSERT isn't in repo SQL.
   Allowed MIME types? File size limit? RLS path expected?

4. **`vat_filing_cadence` column on `businesses`** — referenced from the
   OAuth callback but no CREATE-column DDL is in repo. Whether it has a
   CHECK constraint (`'monthly'`/`'quarterly'`/`'annually'`) needs
   verification before assuming.

5. **Is `supplier_mappings` table still in prod, populated, and read by
   anything other than the legacy `app/api/integrations/fortnox/route.ts`
   sync function?** If yes, the new categorisation design needs to
   either consume it or formally retire it.

6. **What's actually in `document_chunks.embedding` today?** Column +
   ivfflat index exist. Is the embedding column populated? With which
   provider? Affects whether we can lean on existing pgvector
   infrastructure for the new retrieval layer.

7. **Whether the Fortnox `Supplier` master and `Article` master endpoints
   are pullable with the scopes already granted (`supplier`, `article`).**
   Scopes are requested, but no `lib/fortnox/api/suppliers.ts` /
   `articles.ts` exist. Would unblock supplier-org-nr capture and
   article-master sync for the new design.

8. **`opening_days` coverage across forecasters.** `daily.ts` /
   `daily-v2.ts` / `llm-adjust.ts` read it. `hourly.ts` / `monthly.ts` /
   `recency.ts` — unverified. Worth confirming before adding new
   forecast surfaces.

9. **Whether the pre-existing `fortnox_uploads` table's
   `created_via` / `pdf_sha256` columns are also enforced on the
   supplier-invoice PDF path.** Resultatrapport path: yes (per M047
   guardrails). Supplier-invoice path persists via the M078 RPC, which
   takes `supplier_fortnox_number` + `fortnox_invoice_number` + date and
   inserts directly into `supplier_invoice_lines` without a job-side
   `created_via` tag.

10. **Whether the `current_user_org_ids()` storage policy gap is
    actively biting any user today.** Single-org accounts are unaffected;
    only users in 2+ orgs are. Verify membership counts in prod.

---

*End of report. Total source files cited: ~50. No code or DB modified.*

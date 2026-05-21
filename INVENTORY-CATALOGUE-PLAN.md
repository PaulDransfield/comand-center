# Inventory & Product Catalogue — Plan

> **Owner:** Paul Dransfield
> **Drafted:** 2026-05-21
> **Status:** Design — not yet implementing
> **Builds on:** `UX-INFRA-DEBT.md` item #3 (Suppliers × BAS account split), Session 17 invariants in `CLAUDE.md` (Fortnox apply pipeline), `feedback_fortnox_extraction_stack` memory

---

## 0. The prime directive

> **One real-world product = exactly one row in `products`. Forever. Across re-imports, across spelling variants, across article-number rotations, across business switches.**

Every architectural choice below exists to make duplicate-prevention *structural*, not a thing we clean up later.

If at any point during implementation a code path could plausibly create a second `products` row for the same Lavazza, that code path is wrong. Stop and route through the matcher.

---

## 1. Why this exists (and what we get for free)

### The user-facing reason

Owners want an inventory module: count stock, see what's running out, know what to reorder. That requires a clean product catalogue that doesn't drift. Fortnox already knows everything they buy — we just need to harvest it intelligently.

### What's already in place (we're not starting from zero)

- **`/api/integrations/fortnox/drilldown`** already fetches voucher rows + supplier invoice metadata for the `/overheads/review` flag detail pane (see CLAUDE.md Session 17 §drill-down).
- **`/api/integrations/fortnox/invoice-pdf`** already does the OAuth-authenticated invoice fetch.
- **Token refresh** through `getFreshFortnoxAccessToken()` is the single chokepoint (see `feedback_fortnox_token_refresh_required` memory).
- **Backfill worker pattern** at `/api/cron/fortnox-backfill-worker` already paces Fortnox API calls (see `feedback_fortnox_backfill_pdf_priority` memory).

What we **don't** have:
- A `/supplierinvoices/{n}` rows persistence layer (we fetch live each time, never store).
- A clustering / dedup engine.
- A catalogue UI.
- An inventory-count UI.

### What this unlocks beyond inventory itself

Even if the actual count screen never ships, having the catalogue + line-item history gives us:

1. **Supplier price-creep at SKU level** — instead of "your overall food spend went up 8%" we can say "Bestla's olive oil went from 245 kr/L to 289 kr/L over six months". Same alert system, far more actionable.
2. **Substitution detection** — owner quietly switched from Brand A to Brand B; pattern visible from invoice deltas.
3. **Seasonal ordering signatures** — auto-detect that cleaning supplies spike every September; useful for cash-flow forecasting.
4. **Days-of-cover estimates** — for any SKU, "you've bought ~10kg of olives every 11 days for the last quarter". Owner counts 4kg today; reorder hint in 3 days. No recipe data needed.
5. **(Future) Food-cost leak detection** — once recipes layer in, "Carbonara sold 84× this month → that's 25L cream usage → you only bought 12L → something is leaking". Phase D.

---

## 2. The data model

Three tables. The relationship matters more than the columns.

```
                ┌──────────────────┐
                │   products       │   ← canonical catalogue
                │   (one per       │     · what inventory reads
                │   real thing)    │     · what UI displays
                └────────┬─────────┘
                         │
                         │ 1:N
                         ▼
                ┌──────────────────┐
                │ product_aliases  │   ← every spelling we've ever seen
                │ (the dedup       │     · `(supplier, article_number)` exact-keys
                │  unlock)         │     · normalised description fallbacks
                └────────┬─────────┘
                         │
                         │ 1:N
                         ▼
                ┌──────────────────────────┐
                │ supplier_invoice_lines   │   ← raw audit trail
                │ (every line ever         │     · never displayed to owner directly
                │  pulled, by invoice)     │     · always joined to products via alias
                └──────────────────────────┘
```

### `products` (canonical catalogue)

```sql
CREATE TABLE products (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Owner-curated display name. Defaults to the first-seen alias description,
  -- but owner can rename without breaking history.
  name                  TEXT NOT NULL,

  -- 'food' | 'beverage' | 'alcohol' | 'cleaning' | 'takeaway_material' |
  -- 'disposables' | 'other'.
  -- First-pass derivation = BAS account → category map.
  -- Owner override stored here; null = use BAS routing.
  category              TEXT NOT NULL,
  category_overridden   BOOLEAN NOT NULL DEFAULT FALSE,

  -- The unit the owner wants to COUNT in. Often differs from the
  -- invoice unit (owner counts "bottles", invoice says "L").
  -- Phase C feature; nullable for now.
  count_unit            TEXT,
  invoice_unit          TEXT,                     -- most-common unit seen on invoices
  unit_conversion       NUMERIC,                  -- 1 count_unit = X invoice_unit

  -- The supplier we usually buy this from (most recent invoice wins).
  default_supplier_id   UUID REFERENCES suppliers(id),

  -- Created when the matcher first sees a row that doesn't fit any existing
  -- product (either auto-created by step-2 below, or owner-confirmed via
  -- /inventory/review).
  created_via           TEXT NOT NULL,            -- 'auto_exact' | 'auto_fuzzy' | 'owner_review' | 'manual'
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Owner can archive products they no longer stock. Soft-delete only.
  archived_at           TIMESTAMPTZ,

  UNIQUE (business_id, name)
);

CREATE INDEX products_business_idx  ON products (business_id) WHERE archived_at IS NULL;
CREATE INDEX products_category_idx  ON products (business_id, category) WHERE archived_at IS NULL;
```

### `product_aliases` (every spelling)

```sql
CREATE TABLE product_aliases (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id           UUID NOT NULL REFERENCES suppliers(id),

  -- Fortnox structured data when available — gold-standard key
  article_number        TEXT,

  -- Free-text description as it appeared on the invoice. Stored verbatim
  -- so we can show owner exactly what came in.
  raw_description       TEXT NOT NULL,

  -- Lowercased, whitespace-normalised, punctuation-stripped version
  -- used for trigram matching. Generated column.
  normalised_description TEXT NOT NULL,

  unit                  TEXT,
  match_method          TEXT NOT NULL,        -- 'article_number' | 'description_exact' | 'fuzzy_same_supplier' | 'fuzzy_cross_supplier' | 'owner_confirmed'
  match_confidence      NUMERIC,              -- 0..1; NULL for exact matches
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_count            INTEGER NOT NULL DEFAULT 1
);

-- The two dedup unique constraints. These are the load-bearing structures
-- of the entire system. Removing them = duplicates can happen.
CREATE UNIQUE INDEX product_aliases_article_uniq
  ON product_aliases (business_id, supplier_id, article_number)
  WHERE article_number IS NOT NULL;

CREATE UNIQUE INDEX product_aliases_desc_uniq
  ON product_aliases (business_id, supplier_id, normalised_description, unit)
  WHERE article_number IS NULL;

-- Trigram index for the fuzzy matcher (step 3 + 4 of the ladder).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX product_aliases_desc_trgm_idx
  ON product_aliases USING gin (normalised_description gin_trgm_ops);
```

### `supplier_invoice_lines` (audit trail)

```sql
CREATE TABLE supplier_invoice_lines (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id           UUID NOT NULL REFERENCES suppliers(id),

  -- Fortnox invoice number — links back to the supplier invoice header.
  fortnox_invoice_number TEXT NOT NULL,
  invoice_date          DATE NOT NULL,           -- header's InvoiceDate
  invoice_period_year   INTEGER NOT NULL,        -- derived for cheap WHERE filtering
  invoice_period_month  INTEGER NOT NULL,

  -- The Fortnox row index within the invoice (rows are 1-based in the API).
  -- Together with (business_id, invoice_number) makes the row unique.
  row_number            INTEGER NOT NULL,

  -- Raw fields from the API response — never mutated after insert.
  raw_description       TEXT NOT NULL,
  article_number        TEXT,
  quantity              NUMERIC,
  unit                  TEXT,
  price_per_unit        NUMERIC,
  total_excl_vat        NUMERIC NOT NULL,
  vat_rate              NUMERIC,
  account_number        TEXT,                    -- BAS account from /SupplierInvoiceRow.AccountNumber

  -- The bridge to the catalogue. NULL means the line couldn't be matched
  -- and is sitting in the review queue. NOT NULL = linked, the catalogue
  -- can trust it.
  product_alias_id      UUID REFERENCES product_aliases(id) ON DELETE SET NULL,
  match_status          TEXT NOT NULL,           -- 'matched' | 'needs_review' | 'skipped' | 'not_inventory'

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (business_id, fortnox_invoice_number, row_number)
);

CREATE INDEX supplier_invoice_lines_supplier_idx
  ON supplier_invoice_lines (business_id, supplier_id, invoice_date DESC);
CREATE INDEX supplier_invoice_lines_review_idx
  ON supplier_invoice_lines (business_id, match_status, created_at DESC)
  WHERE match_status = 'needs_review';
CREATE INDEX supplier_invoice_lines_product_idx
  ON supplier_invoice_lines (product_alias_id)
  WHERE product_alias_id IS NOT NULL;
```

### Multi-tenancy

Every table has `business_id` and `org_id`. RLS policies follow the same pattern as Session 14's `current_user_org_ids()` helper. Vero's "Lavazza" and Rosali's "Lavazza" are different rows in `products`; cross-business catalogue sharing is **explicitly out of scope** (revisit later if owners ask).

---

## 3. The matching ladder

When a new `supplier_invoice_lines` row comes in (either from initial backfill or live sync), the matcher walks these steps in order. **First match wins.** A row never visits more than one branch.

### Step 1 — exact `(supplier_id, article_number)`

If `article_number IS NOT NULL`, look it up in `product_aliases` keyed by `(business_id, supplier_id, article_number)`. Hit = link the line to that alias, done. Update `alias.last_seen_at` and `seen_count`.

Why: When suppliers send structured invoices (Martin & Servera, Menigo, Procurator etc.) the article number is stable across orders and across re-invoicing of the same SKU. This is the gold-standard match — zero false positives possible.

### Step 2 — exact normalised description (same supplier)

If step 1 didn't fire (no article number, or no match): compute `normalised_description` (see normalisation below) and look up `(business_id, supplier_id, normalised_description, unit)`. Hit = link.

Why: Many suppliers (small local ones especially) don't fill in article numbers but always type the description identically. "Kaffebönor Lavazza 1kg" → "Kaffebönor Lavazza 1kg" → exact hit.

### Step 3 — fuzzy match within same supplier (trigram > 0.80)

Run a `pg_trgm` similarity query:

```sql
SELECT id, product_id, normalised_description,
       similarity(normalised_description, $1) AS sim
FROM product_aliases
WHERE business_id = $biz AND supplier_id = $supplier
ORDER BY normalised_description <-> $1
LIMIT 1;
```

If `sim > 0.80` → auto-link with `match_method = 'fuzzy_same_supplier'`. Also insert a NEW alias row for this exact spelling so step 2 catches the next instance.

Why 0.80: empirically, within a single supplier the only variance is word-order tweaks ("Kaffebönor Lavazza" vs "Lavazza Kaffebönor") or punctuation. 0.80 is comfortably above the noise floor; cross-spellings of the same SKU score ~0.85–0.95.

### Step 4 — fuzzy match across all suppliers (trigram > 0.85)

If step 3 didn't fire: same query but **without** the `supplier_id` filter.

If `sim > 0.85` → auto-link AND insert a new alias under the existing product but with the new `supplier_id`. This captures "owner switched from Bestla to Martin & Servera for the same olive oil".

Why higher threshold (0.85): cross-supplier false positives are more common — different suppliers may sell "the same" product with non-trivial spec differences. We want to err on the side of "create new product" rather than "wrongly merge".

### Step 5 — queue for owner review

Nothing matched. Insert the line with `match_status = 'needs_review'` and `product_alias_id = NULL`. It surfaces in `/inventory/review` (see §4).

The matcher logs the top-3 candidates (whatever the trigram query found, regardless of threshold) into a `match_candidates JSONB` column on the line, so the review UI can show the owner the near-misses.

### Normalisation function (the bedrock)

```ts
function normaliseDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[åä]/g, 'a').replace(/[ö]/g, 'o')   // sv→ascii for trigram robustness
    .replace(/[^\w\s]/g, ' ')                       // strip punctuation
    .replace(/\s+/g, ' ')                           // collapse whitespace
    .replace(/\b\d+(st|kg|g|l|ml|cl|pack|frp)\b/g, m => m.replace(' ', '')) // "5 kg" → "5kg"
    .trim()
}
```

The deliberate quirks:
- We don't strip numbers — "Lavazza 1kg" and "Lavazza 500g" are different products and must score < 0.8.
- We **do** unify unit suffixes (`5 kg` → `5kg`) so spacing doesn't cost similarity points.
- We don't stem (no word root reduction) — Swedish stemmers add false positives.

The function is committed to a file (`lib/inventory/normalise.ts`) and used by both the ingestion path and the UI's search box. If we change it, we re-normalise existing rows in a migration — never silently per-call.

### Idempotency

Re-running the matcher on a line that already has `product_alias_id IS NOT NULL` is a no-op. The matcher only touches `match_status IN ('needs_review', NULL)` rows. The backfill worker can crash and resume freely.

---

## 4. Owner curation — `/inventory/review`

The review queue surfaces the step-5 rows from §3. UI structure:

```
─────────────────────────────────────────────────────────────
●●● Inventory  ›  Review                        Pending: 8
─────────────────────────────────────────────────────────────

  New product seen from Bestla — first time
  ┌──────────────────────────────────────────────────────┐
  │  Olivolja extra virgin 5L Monini                     │
  │  art-nr: 1842 · unit: st · 1 245 kr · 2026-05-18    │
  │                                                       │
  │  Looks similar to:                                    │
  │  ◯ Olivolja 5L (Martin & Servera) ────── 84% match   │
  │  ◯ Olivolja extra virgin 3L (Bestla) ─── 71% match   │
  │  ● Create as a new product                            │
  │                                                       │
  │  [Skip — not inventory]   [Confirm →]                 │
  └──────────────────────────────────────────────────────┘
```

### Behavior

- **Default selection** is whichever candidate scored highest, **only if** ≥ 0.70. Otherwise default = "Create as new product".
- "Skip — not inventory" marks the line `match_status = 'not_inventory'` so we never ask again. Useful for service fees, delivery charges, returns.
- "Confirm →" with the existing product selected: inserts a new alias row pointing at that product, links the line. **All other unmatched lines from this supplier with similar description get auto-matched in the background** within ~5 seconds (re-run matcher on `needs_review` rows where trigram against the new alias > 0.8).
- "Create as new product": opens a 3-field form — name (pre-filled with cleaned-up description), category (pre-filled from BAS account), count_unit (pre-filled with invoice unit). Submit creates product + alias + links line.

### Realtime

Supabase Realtime subscription on `supplier_invoice_lines` filtered by `business_id` + `match_status = 'needs_review'` — same pattern as the Fortnox upload review modal. Owner sees new items appear without refreshing.

### Cadence

Empirically: a new Vero or Rosali doing first 12-month backfill will surface ~150–250 items into the queue. Subsequent weeks: 1–5 new items per week as suppliers introduce SKUs or owners add new ones. After ~3 months the queue is effectively empty most days.

---

## 5. The inventory module (Phase C)

Brief sketch — full design comes after we see what the catalogue actually looks like in practice.

### New tables

```sql
CREATE TABLE inventory_counts (
  id              UUID PRIMARY KEY,
  business_id     UUID NOT NULL,
  product_id      UUID NOT NULL REFERENCES products(id),
  counted_at      TIMESTAMPTZ NOT NULL,
  counted_by      UUID NOT NULL,                  -- user_id
  quantity        NUMERIC NOT NULL,               -- in count_unit
  notes           TEXT,
  UNIQUE (business_id, product_id, counted_at)
);

CREATE TABLE inventory_thresholds (
  business_id     UUID NOT NULL,
  product_id      UUID NOT NULL REFERENCES products(id),
  reorder_at      NUMERIC NOT NULL,               -- "alert when below this"
  reorder_unit    TEXT,
  PRIMARY KEY (business_id, product_id)
);
```

### Three screens

1. **`/inventory`** — read-only catalogue grouped by category. One row per product. Columns: Name, Category, Default supplier, Last bought, Avg consumption/week (derived from invoice frequency), Last counted, Current stock.
2. **`/inventory/count`** — Tap a product → enter qty → submit. Auto-saves. Multi-staff safe (last write wins per `(product, counted_at)`).
3. **`/inventory/alerts`** — products where current stock < reorder threshold, sorted by urgency. Each card has "mark as ordered" (records the reorder date and snoozes alert).

### Derived consumption rate

For each product, weekly consumption = `SUM(quantity over last 90 days) / 12.86 weeks`. This is approximate but actionable — owner only needs to know "olive oil is depleting faster than I'm buying", not the exact gram/week figure.

Recipe-based consumption is Phase D (out of scope here).

---

## 6. Phasing

### Phase A — Capture (≈ 1 week)

**Deliverables:**
- Migration M053 (or whatever's next): three tables + indexes + pg_trgm extension
- New endpoint `/api/inventory/lines/backfill` — pulls `/supplierinvoices/{n}` for every existing invoice on the business, persists rows. Tagged `created_via='fortnox_backfill'`. Skip if `(business_id, invoice_number)` already has lines.
- New endpoint `/api/cron/inventory-lines-sync` — daily incremental for invoices created/updated since last run
- Helper `lib/inventory/normalise.ts` (the normalisation function from §3)
- Helper `lib/inventory/matcher.ts` — implements the 5-step ladder. Returns `{ aliasId, productId, method, confidence } | null`
- Smoke test: pick one Vero invoice manually, run backfill on just that, inspect `supplier_invoice_lines` content

**Exit criteria:** All historical supplier invoices for the test business have populated `supplier_invoice_lines` rows. Matcher hasn't run yet — every row is `match_status = 'needs_review'` and `product_alias_id IS NULL`.

### Phase B — Clustering + review queue (≈ 1 week)

**Deliverables:**
- Migration M054: `match_candidates JSONB` column on `supplier_invoice_lines` (only used for review UI hints)
- New endpoint `/api/inventory/match` — runs the matcher on a batch of `needs_review` rows. Idempotent; safe to call repeatedly.
- New endpoint `/api/inventory/review` — GET = queue contents with candidates, POST = owner action (merge / create / skip)
- New page `/inventory/review` — the queue UI from §4
- Run the initial matcher pass over the Vero backfill. Inspect: how many auto-matched (steps 1–4) vs how many landed in the queue. Target: > 70% auto-match on the first pass.

**Exit criteria:** Owner has worked through the Vero queue. `products` table populated. < 10 items in `needs_review` state, and new daily incoming invoices auto-match cleanly.

### Phase C — Inventory module (≈ 1–2 weeks)

**Deliverables:**
- Migration M055: `inventory_counts`, `inventory_thresholds`
- The three screens from §5
- Reorder-alert tile on `/dashboard`

**Exit criteria:** Vero owner can complete a weekly stock-take in < 15 min and see reorder alerts.

### Phase D — Recipes & food-cost leak detection (deferred)

Out of scope for this plan. Mention only so we don't accidentally build something that precludes it. The `products` schema is recipe-ready (`count_unit` is the bridge to ingredient ledgers).

---

## 7. Edge cases (handle in Phase A unless noted)

### Invoices with no rows

Some Fortnox invoices have `<SupplierInvoiceRows>` empty — the supplier sent a single-total invoice (typical for service contracts, monthly subscriptions, generic "January order" lump-sums). Three responses:

1. **Phase A:** Skip these silently. Log them in `unprocessable_invoices` table with reason so we can audit later. They never enter the catalogue.
2. **Phase A.5 (optional):** If the original PDF is in `fortnox_uploads`, route to a Claude-based PDF row-extraction (re-use the validators-then-AI pipeline from Session 16 — `feedback_fortnox_apply_guardrails`). Output structured rows, validate, persist. Same chokepoint discipline.
3. **Phase B+:** Owner manually adds rows via a "split this invoice" UI.

### Credit notes / returns (negative quantities)

Fortnox represents these as invoices with negative `Quantity` and `Total`. The matcher should treat them identically — same product link, just negative numbers in the line. Consumption-rate calc handles signed sums correctly.

### Service fees / delivery / postage rows

These show on invoices but aren't inventory items. BAS account routing catches most (5xxx accounts ≠ inventory categories). The matcher should tag `match_status = 'not_inventory'` automatically when `account_number` is outside the inventory range (configurable list — see §8 open questions).

### Multi-currency

Some Swedish restaurants buy directly from European suppliers (Italian wine, Portuguese olive oil). Fortnox stores the row in the invoice's `Currency` with `CurrencyRate`. Store both raw `price_per_unit` and computed `price_per_unit_sek = price_per_unit * CurrencyRate`. Trends + alerts always use SEK; raw is for the audit trail.

### Article numbers that change

Suppliers occasionally renumber their SKUs (system migration, product relaunch). Old article number stops appearing; new one shows up with similar description. Trigram fuzzy match (step 3) handles this naturally — the new spelling clusters with the old product's existing aliases. The new article number gets added as a new alias under the same product.

### Owner-driven splits and merges

After a product is created, owner may realise:
- **Merge:** "Wait, these two products are the same" → admin action in `/inventory`. Moves all aliases + lines from product B → product A. Deletes product B.
- **Split:** "These two aliases shouldn't be the same product" → admin action to unbundle. Moves one alias to a newly-created product. Past lines need owner decision: stay attributed to old product or move to new.

Both operations log to an `inventory_audit` table (Phase C deliverable, not Phase A).

### Deleted Fortnox invoices

If an invoice is voided in Fortnox after we've ingested its lines, the next sync should mark the lines `void = TRUE` and exclude them from consumption-rate calcs. Don't hard-delete — preserve audit trail.

### Brand consolidation (one product, many suppliers)

Bestla used to be the only olive oil supplier; now owner buys from Martin & Servera too. The matcher's step 4 (cross-supplier fuzzy) handles this. The product's `default_supplier_id` updates to whoever supplied the most recent invoice. Owner can pin a different default in the catalogue UI.

---

## 8. Open questions (decide before implementing Phase A)

These are the calls the owner needs to make so the implementation knows what to build:

### Q1 — Which BAS accounts are "inventory" accounts?

We need a list of `account_number` ranges that count as inventory line-items (so step 5's "queue for review" only fires for those). Tentative starting set, please confirm:

| BAS account | Meaning | Inventory? |
|---|---|---|
| 4010 | Råvaror (food raw materials) | ✅ |
| 4011 | Alkohol | ✅ |
| 4012 | Dryck (non-alcoholic) | ✅ |
| 4015 | Förbrukningsmaterial / disposables | ✅ |
| 5410 | Förbrukningsinventarier (small consumables) | ✅ |
| 5460 | Rengöringsmedel | ✅ |
| 6230 | Datakommunikation | ❌ |
| 5xxx (rest) | Premises / utilities / repairs | ❌ |
| 6xxx | Office / admin | ❌ |
| 7xxx | Personnel costs | ❌ |

Anything else added/removed?

### Q2 — Default for "Skip — not inventory" lines

When a line has an inventory BAS account but the owner has marked similar lines as `not_inventory` in the past (e.g. a specific supplier-fee line that always shows under 4015), should we auto-skip future identical lines or always re-ask? Recommend: auto-skip after the third confirmation of the same alias.

### Q3 — Backfill depth

How far back do we pull? Options:
- **a)** Match the Fortnox 12-month backfill window already in use.
- **b)** Match the PDF backfill window (only what was uploaded, may be longer).
- **c)** All-time (Fortnox keeps everything; quota cost ~one API call per invoice).

Recommend (a) — matches existing pipeline, ~150 invoices for Vero, manageable.

### Q4 — Cross-business sharing

Should Rosali's catalogue benefit from Vero's curated catalogue (both buy from Bestla)? Recommend **no for now** — too easy to leak product data across tenants. Defer until at least 5 paying customers.

### Q5 — Where does the matcher run?

Three options:
- **a)** Synchronous inside the backfill / sync endpoint
- **b)** Async job queue (same dispatcher/worker pattern as extraction_jobs, M017)
- **c)** pg_cron-driven loop

Recommend (b) — Phase A backfill could fire ~200 matcher calls; async keeps the user-triggered backfill endpoint quick. Reuse the existing job-queue scaffolding.

### Q6 — `not_inventory` filter granularity

Three levels of "skip": per-line (one-off), per-alias (always skip this exact spelling), per-supplier+account-pair (skip all 5840 lines from Bestla). Recommend: alias-level only in Phase A; per-supplier rules come in Phase C as an admin tool.

---

## 9. What this changes in existing code

- **`/api/integrations/fortnox/drilldown`** (M051 cache): when a line is now in `supplier_invoice_lines`, drilldown can read locally instead of refetching from Fortnox. Cache hit % goes up; live API calls drop. Backwards-compat: fall back to live fetch if local rows missing.
- **`/overheads/review` flag detail pane**: the "Show invoices" expansion can now also show "Top SKUs in this category for this supplier" — better drill story.
- **`/suppliers/[id]` drawer (we're about to build)**: add a "Products this supplier carries" tab listing the products table linked via aliases. Spend-by-product chart.
- **`/api/cron/master-sync`**: add inventory-lines incremental step after the existing aggregator step.
- **`/api/cron/fortnox-backfill-worker`**: optionally trigger an inventory-lines backfill when the existing PDF backfill completes for a business (or leave separate — TBD per Q3).
- **`/dashboard`**: new tile "Inventory reorder alerts" once Phase C ships.

No existing code path is broken or deprecated by this plan. The matcher is purely additive — even if it produces 100% wrong groupings, existing aggregation / forecasting / dashboards keep working unchanged because they don't read from these tables.

---

## 10. Migration sequence

Numbered for the SQL editor. Each is independently reversible (rollback notes in each file).

1. **M053 — products / product_aliases / supplier_invoice_lines + pg_trgm**
   - Create extension, three tables, indexes, RLS policies.
   - Rollback: `DROP TABLE` in reverse FK order; `DROP EXTENSION pg_trgm` only if no other consumer.

2. **M054 — match_candidates JSONB column + matcher RPC**
   - `ALTER TABLE supplier_invoice_lines ADD COLUMN match_candidates JSONB`.
   - `CREATE OR REPLACE FUNCTION match_invoice_line(line_id UUID) RETURNS UUID` — runs the 5-step ladder inside Postgres. Called by both the API and the cron worker.
   - Rollback: `DROP FUNCTION`, `DROP COLUMN`.

3. **M055 — inventory_counts + inventory_thresholds** (Phase C only)
   - Two new tables + RLS.

4. **M056 — inventory_audit** (Phase C only)
   - Audit log for merges/splits/reassignments.

---

## 11. Out of scope (explicitly)

- **Recipes** — Phase D. Mentioned for context only.
- **Sales-side consumption** — requires recipe data + POS integration mapping.
- **Multi-currency reconciliation beyond SEK conversion** — we'll show original currency in line detail but every aggregate is SEK.
- **Per-staff inventory counts** — anyone with business access can record a count.
- **Mobile-native count UI** — web works on mobile, fine for Phase C. Native app is a separate question.
- **Supplier APIs beyond Fortnox** — if a customer uses a different bookkeeping system, this plan needs adaptation (Phase A is mostly Fortnox-coupled). Out of scope until non-Fortnox demand exists.
- **Predicting future orders / auto-reorder** — Phase E if ever.

---

## 12. Memory hooks (for future sessions)

When this lands, write these memories:
- `feedback_inventory_dedup_invariant` — one product = one row, structurally enforced via unique indexes on `product_aliases`. The matcher ladder is the only authorised path to creating an alias. Never write to `product_aliases` directly from a route handler.
- `feedback_inventory_matcher_thresholds` — 0.80 same-supplier, 0.85 cross-supplier. Lower = false positives, higher = false-negative queue overload.
- `project_inventory_phase_a_done` (when shipped) — record the actual auto-match rate observed on Vero's backfill.
- `reference_fortnox_supplier_invoice_rows` — `/3/supplierinvoices/{n}` returns `SupplierInvoiceRows` array; field names listed in §1.

---

## 13. Definitions of "done"

- **Phase A done when:** every existing supplier invoice on the test business has populated `supplier_invoice_lines` rows; matcher hasn't run; cron is in place.
- **Phase B done when:** owner has cleared the initial review queue, < 10 `needs_review` rows remain, new daily invoices auto-match at > 90%.
- **Phase C done when:** owner can complete a weekly stock-take in < 15 min and the reorder-alert tile shows zero false positives over a two-week trial period.

Each phase is shippable independently. We could stop after A and still have unlocked the SKU-level supplier price-drift analytics. We could stop after B and still have a usable read-only catalogue. C is what the user actually asked for; A and B are what makes C work without manual data entry.

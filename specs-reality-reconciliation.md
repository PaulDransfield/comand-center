# CommandCenter — Specs ↔ Reality Reconciliation

**Status:** Reconciliation pass after the current-state investigation — 2026-05-30
**Owner:** Paul Dransfield
**Reconciles:** the six design specs (extraction, categorization-learning, recipe-costing, production-logging, prep-list, waste-tracking, inventory-stock-counting) against `current-state-report.md`.

> **The one-line reframe:** the app is much further along than the specs assumed. Large parts of what we "designed" already ship. So every spec moves from **build** to **extend / harden**, mapped onto the real tables and files below. Build nothing that already exists; add only the genuinely missing pieces.

---

## 1. Spec concept → real entity map

| Spec concept | Already exists as | Status |
|---|---|---|
| Canonical item (`canonical_item`) | `products` (M075) | exists |
| Alias rule (`alias_rule`) | `product_aliases` (M075, two partial unique indexes) | exists |
| Supplier nomenclature mapping | `lib/inventory/matcher.ts` 5-step ladder + `normalise.ts` | exists |
| Learning loop / confirmed examples | `inventory_review_outcomes` (M099) used as in-context few-shot by `/api/inventory/review/ai-suggest`; `inventory_review_suggestions` cache | exists |
| Review queue (the "other" bucket) | `supplier_invoice_lines.match_status='needs_review'`; `/inventory/review` | exists |
| Per-supplier skip override | `supplier_classifications` (M083) | exists |
| Invoice lines | `supplier_invoice_lines` (M075) | exists |
| Fortnox invoice cache | `fortnox_supplier_invoices` (M098 — **verify applied**) | exists? |
| PDF extraction job | `invoice_pdf_extractions` (M078) + `apply_invoice_pdf_extraction` RPC | exists |
| Fortnox booking ground truth | `fortnox_vouchers_cache` (M080) — Account/Debit/Credit reliable | exists |
| Multi-currency / FX | `fx_rates` (M088, daily ECB, cross-tenant) | exists |
| Recipes + waste% | `recipes` + `recipe_ingredients` (M084), per `business_id` | exists |
| Stock locations | `stock_locations` (M091) | exists |
| Stock counts | `stock_counts` + `stock_count_lines` (M092) | exists |
| Waste log | `waste_log` (M093) | exists |
| POS sales / menu | `pos_sales` + `pos_menu_items` (M097 — **verify applied**) | exists? |
| Cross-business peer grouping | `business_cluster_membership` (M055) | exists |
| AI cascade (Haiku→Sonnet) | `lib/inventory/pdf-extractor.ts`; models in `lib/ai/models.ts` | exists |
| Design tokens | `UXP.*` / `Z.*` in `lib/constants/tokens.ts` | exists |

**Tenant model:** `organisations → businesses`; RLS via `current_user_org_ids()` (`= ANY(...)`). The only intentionally cross-tenant tables today are `fx_rates` and `school_holidays`.

---

## 2. Per-spec deltas

### 2.1 Categorization & Learning — biggest reframe

**Reframe: harden the existing loop, don't build one.** `product_aliases` + the 5-step matcher + `inventory_review_outcomes` already do alias matching, auto-insertion, owner-confirm promotion (`match_method='owner_confirmed'`), and in-context learning from recent corrections. Our spec's value is the parts that **don't** exist:

- **Demotion & decay** — today rules only ever get added; nothing pulls a wrong/stale rule back. **Net-new.** (Our §3 demotion.)
- **Audit of confident auto-links** — trigram >0.80/0.85 auto-links with no spot-check; a confident-wrong link is invisible. **Net-new.** (Our §4 audit sampling.)
- **Accuracy measurement** — no held-out metric to gate changes. **Net-new.**
- **Promotion threshold beyond first owner-confirm** — today one confirm writes a permanent alias; our N-consistent-confirmations + cross-customer promotion is **net-new** and gated on the supplier master (below).

**Correction to the spec — ground truth source was wrong.** Spec §2 said "read the Fortnox booking (BAS `account_number`) as primary." Reality: `account_number` is ~100% NULL on supplier invoices (Chicce: 3218/3218). **Fix:** primary signal stays `supplier_name + raw_description` (what the matcher uses); ground-truth corroboration comes from **`fortnox_vouchers_cache` (M080)**, which reliably carries Account/Debit/Credit — cross-reference the voucher to back-fill the line's account, don't depend on the invoice header.

**Two ingestion paths must be orchestrated.** `backfill-worker.ts` (`source='fortnox_row'`) and `pdf-extractor.ts` (`source='pdf_extraction'`) both write `supplier_invoice_lines`, disambiguated by `source` but not orchestrated. **Add an explicit gate:** API rows first; fall back to PDF when API rows are empty/blank-description (Chicce: 3218/3218 blank). Honour CLAUDE.md L41 (API skips months with a PDF-applied row).

**Partial-unique-index trap:** any new writer to `product_aliases` must SELECT-then-INSERT with 23505 retry — PostgREST `.upsert({onConflict})` cannot drive its partial uniques.

**Embeddings:** `document_chunks.embedding` + ivfflat index exist — **verify populated**. If yes, reuse pgvector for retrieval; if no, the existing `inventory_review_outcomes` in-context approach already works without embeddings — don't add a vector store just to add one.

### 2.2 Extraction

- **VAT → `lib/sweden/vat.ts`** (created by the hotfix). All new code consumes it. The date-effective 6% food rule lives here; **VAT rate never infers channel** (the confirmed live bug).
- **Align to the existing extractor**, don't replace it: the `record_invoice_rows` tool schema (`pdf-extractor.ts:717-753`) already emits rows; our additions (`source_language`, currency fields) are incremental columns, and our validation additions extend the existing validator suite (`total_mismatch` + rescues, `unusual_vat ∈ {0,6,12,25}`).
- **Currency already ships:** `fx_rates` (ECB daily). Reference it; our multi-currency section largely describes shipped infra. Prefer the Fortnox-booked SEK + rate, fall back to `fx_rates` by date.
- **`normalise.ts` is bedrock** — changing it silently corrupts the alias unique index; any normalization change needs a re-normalization migration.

### 2.3 Recipe-costing

- Map onto `recipes` + `recipe_ingredients` (M084). Waste% exists. **Cost basis decision resolved: latest invoice price only** (no weighted-average/FIFO ships today; recipes recompute per render). Our open decision #1 is closed by reality.
- **Franchise master/location is net-new** — every recipe is per `business_id`; no `master_recipe_id` / `inherited_from`. ~3 columns + override semantics + UI. **Decide: v1 or later.**
- **Verify against CC (came from the QVANTI benchmark, not confirmed in CC):** "can be inventoried" recipe flag, cost-groups, and the recipe↔POS-sales-article link for sales quantity. Don't assume these exist; confirm before speccing build.

### 2.4 Inventory & stock-counting

- Fold onto real names: `stock_locations` (M091), `stock_counts` + `stock_count_lines` (M092), `waste_log` (M093). Counts already snapshot price-at-count — matches our immutability intent.
- **Verify:** is there a perpetual **movement ledger**, or only periodic counts today? If counts-only (likely), our `stock_movement` ledger is the net-new addition — and our "works with zero POS, count-driven" framing matches reality.
- **Transfers** between locations: not seen in the report — likely net-new. Verify.
- POS-driven theoretical depletion depends on `pos_sales` (M097 — verify applied).

### 2.5 Production-logging, prep-list, waste-tracking

- Waste capture writes to / extends **`waste_log` (M093)** rather than a new table.
- Cross-customer governance aligns with the existing **`business_cluster_membership` (M055)** peer-learning pattern (used by `lib/forecast/llm-adjust.ts`) — same principle, supplier-mapping shares ride org-nr.
- **Verify:** mobile surface + a photo storage bucket. `fortnox-pdfs` bucket exists; a prep/production photo bucket is likely net-new (and its policies aren't in repo SQL — see unknowns).
- Franchise master/location dependency same as recipe-costing.

---

## 3. Net-new prerequisites (build these or the specs can't land)

1. **`lib/sweden/vat.ts`** — Phase 0 foundation (the hotfix creates it). Everything downstream consumes it.
2. **`suppliers` master + org-nr** — there is no supplier table today (just Fortnox `SupplierNumber` + denormalized name snapshots). Pull Fortnox `/suppliers` (scope already granted; ~2 days) → keyed by org-nr. **Precondition** for supplier entity resolution *and* the cross-customer alias network.
3. **Fortnox `/articles` pull** (`lib/fortnox/api/articles.ts` — doesn't exist) — for the full-assortment catalogue + images. Scope granted.
4. **Ingestion orchestration gate** — API-first / PDF-fallback (§2.1).
5. **Franchise master-recipe columns** — if franchise is v1.
6. **Prep/production photo storage bucket + mobile surface** — verify, likely net-new.

---

## 4. Reuse, don't reinvent (the report's good patterns)

- **Validation chokepoint:** `/api/fortnox/apply` shape — `findings[]` with `code` / `severity` / `override_allowed` / `acknowledged_warnings`. New pipelines copy this.
- **Idempotency:** SELECT-then-INSERT for partial uniques; partial unique indexes over `.upsert`.
- **RLS:** `org_id = ANY(current_user_org_ids())` on every new table.
- **AI cascade:** Haiku→Sonnet; model strings only from `lib/ai/models.ts` (`AGENT=claude-haiku-4-5-20251001`, `ANALYSIS/ASSISTANT=claude-sonnet-4-6`). Note `@anthropic-ai/sdk` is 0.24 (outdated) — new AI surfaces use direct `fetch()` for caching headers.
- **Design tokens:** consume `UXP.*` / `Z.*` from `lib/constants/tokens.ts` — not raw hex (this also corrects the standalone tokens my landing-page mockup invented).
- **CHECK/enum discipline:** any new enum value (e.g. a new `match_method`, a `food_goods` subcategory) lands DB CHECK + TypeScript in the **same commit** (`feedback_check_constraint_drift`).

---

## 5. Corrected build sequence

- **Phase 0 — foundation & truth-finding.** Ship `lib/sweden/vat.ts` (the hotfix). Resolve the four prod-truth unknowns (§6) before designing the dependent pieces.
- **Phase 1 — harden the existing loop.** Demotion + decay, audit of confident auto-links, accuracy metric — all on the *shipped* `product_aliases` / `inventory_review_outcomes`. High value, low risk, no new tables. Capture already happens.
- **Phase 2 — orchestrate & ground.** API-first/PDF-fallback gate; voucher-as-ground-truth back-fill; build the `suppliers` master + org-nr.
- **Phase 3 — catalogue.** Fortnox `/articles` full-assortment ingestion + images.
- **Phase 4 — recipes & operations.** Franchise master/location (if v1); production-logging, prep-list, waste-tracking onto `waste_log`; stock movement ledger + transfers extensions.
- **Phase 5 — cross-customer alias network.** Gated on the supplier master (Phase 2) + the governance line. Lowest priority, highest leverage long-term.

---

## 6. Still gating — query prod before the dependent designs close

1. **`tracker_line_items` schema** — CREATE TABLE not in repo; needed before any new write near the P&L line items.
2. **Are M097 / M098 / M100 / M104 applied?** Code reads `pos_sales`, `fortnox_supplier_invoices`, scheduling, `review_insights_cache` live, but `MIGRATIONS.md` says pending — confirm.
3. **Is `document_chunks.embedding` populated, and by which provider?** Decides reuse-pgvector vs no-embeddings.
4. **Are Fortnox `supplier` + `article` scopes actually pullable?** Unblocks the supplier master and the catalogue.

# CLAUDE.md — Working Guidelines
> Last updated: 2026-06-01 | Session 23 — matcher quality M112+M113, recipe stack M111+M114, BAS dictionary M115, AI bulk recipe importer with file upload + sub-recipe detection, Edit-Item link-supplier-article, Vero PDF backlog cleanup, two-part invoice-organisation investigation; Phase D watch still active until 2026-06-07
> See ARCHITECTURE-PLAN.md for the full audit + phased roadmap.

> **Session 23 invariants (2026-06-01, matcher quality sweep + recipe stack):**
>   • **`lib/inventory/description-rules.ts` gained nine new arms** (M112 + M113) on 2026-06-01. M112: `lokalhyra | hyra\s+lokal | lokal\s+hyra` for Behrn landlord rent invoices (65 lines flipped at Chicce). M113: `öres.{0,3}och\s+kron` (Kungsholmens rounding) + `brand(släckar|\s+ansulex)` (Tingstad fire-extinguisher service) + `förpackningsavgift` (PAC packaging fee) + `försenings(ersättning|avgift)` (Martin Servera delivery comp, forward-defensive) + `^eng[åa]ngsemballage\b` (Spendrups single-use packaging) + `^europapall(e)?\b` (Carlsberg pallets — "europa"+"palle" not "europ"+"all"; sibling to existing `^eur[-\s]?pall`). All passed both-directions dry-runs. Both SQL backfills (M112 + M113) committed and persisted: 65 + 96 = 161 lines off the review queue.
>   • **`feedback_lexical_similarity_is_not_meaning` memory is load-bearing for ALL future matcher / dedup work.** Owner principle 2026-06-01: "Loka is a drink brand and lokal hyra is rent — try to understand the words before matching them." Trigram / Jaccard / Levenshtein are CANDIDATE filters only, never verdicts. Swedish vocab has too many landmines (Loka brand vs Lokalhyra rent, M vs med, eko vs ekologisk). Product dedup needs an LLM second-pass that knows Swedish restaurant vocab + brand-vs-cost-category. Don't pile thresholds onto lexical similarity hoping to thread the meaning needle.
>   • **M111 — `recipes.yield_amount numeric` + `recipes.yield_unit text`** added. Paired pair invariant via CHECK: both NULL or both set with yield_amount > 0. Lets a sub-recipe declare "1 portion = 250 g of sauce" so parent recipes consume it by weight (e.g. "30 g of White Sauce") instead of integer portions. Engine in `lib/inventory/recipe-cost.ts` sub-recipe branch converts at cost-time via `convertQuantity` from `lib/inventory/unit-conversion.ts`: qty_in_yield_unit / yield_amount = portion_equivalent. Falls back to honest-incomplete (unit_mismatch + null line_cost) when no yield is set OR units are family-incompatible. `loadRecipeIndex` selects + threads yield through `RecipeContextEntry`. PATCH `/api/inventory/recipes/[id]` accepts the paired update; refuses half-set. UI: `YieldEditor` in the recipe drawer header, with **auto-fill suggestion** from sum of ingredient grams ÷ portions (lib/inventory/unit-conversion.ts on the client; ml treated as g at cooking density ≈ 1). Suggestion chip shows when fields empty OR when set yield drifts >5% from sum (cooking reduction hint).
>   • **`/inventory/recipes` is the Phase 1 dish-level margin surface.** Three additions over the bare list (no new page): (1) Dishes / Sub-recipes / All filter pills — default 'dishes' (recipes with selling price set) so menu-engineering numbers don't drown in yield batches. KPI strip recomputes from visible rows. (2) **"Incomplete cost" badge replaces the GP% number** when missing_prices > 0 OR unit_mismatches > 0 — honest-incomplete rule trumps confident-but-wrong. Header chip surfaces total incomplete-cost count when any exist. (3) GP kr renders under GP % as the secondary number (ratio-first money-second precedent). Recipe **type is editable inline** in the drawer header (was static text — bulk-import sets type=null and owners need to fix later).
>   • **`/api/inventory/recipes/import-parse` is the owner-facing AI bulk importer.** Reuses the proven prompt + catalogue-prefix-matching pattern from `/api/admin/onboard/recipes-draft`. AI-quota-gated via `checkAndIncrementAiLimit`. MAX_CATALOGUE = **1500** (NOT 400 — truncation at 400 alphabetical missed every Chicce product past letter G: Mozzarella at 691, Parmigiano at 783, Ruccola at 943, Tomat at 1135). Filter: `.in('category', ['food','beverage','alcohol'])` drops 164 cleaning/disposables noise products. SYSTEM_PROMPT carries explicit chef-language examples — menu writes "mozzarella" / "parmesan" / "parmaskinka" / "ruccola" / "olivolja" / "tomatsås" / "basilika", model matches semantically against catalogue language (Mozzarella per pizza Julienne 2,5kg etc.). Returns drafts without writing. UI: `BulkImportModal` on `/inventory/recipes` — paste → preview → "Create N recipes" loops the existing POST endpoints. Notes auto-tagged "AI DRAFT — …". v2: PDF/image upload via vision (parked).
>   • **`/api/inventory/items/[id]/link-supplier-article` is the canonical owner-driven alias creator.** Closes the cost-gap for products created via the recipe-authoring tool / AI bulk importer (no automatic alias on creation → "Incomplete cost" forever). Takes `{ supplier_invoice_line_id }`, builds the alias key via `lib/inventory/normalise.ts`, REFUSES if an alias already exists pointing to a DIFFERENT product (returns `alias_already_linked_to_other_product` — owner repoints via existing `/product-aliases/[id]/repoint`). Otherwise claims orphan alias or inserts fresh with `match_method='owner_linked'`. Then back-fills every matching `supplier_invoice_line` at the business → `product_alias_id` + `match_status='matched'`. Companion search at `/api/inventory/items/[id]/link-search` returns unmatched lines grouped by supplier+description. UI: "+ Link article" pill in the Supplier articles section header of the EditItemModal.
>   • **`match_method='owner_linked'` joins `owner_confirmed` as the manual-attribution markers.** When auditing alias provenance: `owner_confirmed` came from the review-queue flow, `owner_linked` came from the Edit-Item modal's link picker. Both should NEVER be silently overwritten by automated matching; both are protected at Gate 0 (the safeguard on 0c+0d looks at `hasOwnerConfirmedAlias` — extend to `owner_linked` if/when the principle generalises).
>   • **Sync banner detail copy is action-oriented when needsReview > 0.** `/api/me/sync-progress` invoices job sets `detail = "${needsReview} newly added for review"` + `link = '/inventory/review'` on done state. Banner's JobRow renders an `<a href>` (not onClick — middle-click + open-in-new-tab + keyboard focus all work). Inert span in every other case. Visible for the same 2-minute window the banner already stays after sync — persistent badging on the rail nav is separate scope.
>   • **`sql/vero-pdf-backlog-cleanup.sql` flipped 11 cosmetic-pending → extracted + 37 token-auth-failed → pending** for cron re-pickup at Vero. Distribution post-flip: extracted 554 / no_pdf 440 / needs_review 52 / pending ~37 (cron clears those automatically). The remaining 440 no_pdf are the #88 M&S cluster — owner-hands work in Fortnox UI to verify whether the PDFs were ever uploaded. Re-extract triggering helpers committed at `scripts/trigger-vero-pdf-retry.mjs` + `scripts/diag-vero-pdf-backlog.mjs` for future use.
>   • **`EVENTS-LLM-INTEGRATION-PLAN.md` parks the Ticketmaster → Piece 4 LLM forecast wiring.** ~Half plumbing exists (`lib/events/ticketmaster.ts` + `lib/events/impact.ts` + `/api/cron/events-sync`) but dormant — TICKETMASTER_API_KEY not set, no business geocoding, no Piece 4 prompt hookup, Stockholm-only. Doc captures the four-gap unlock chain (geocode → API key → wire LLM → dashboard card → calibrate), the trust-gate pre-filter rules, the [0.5, 1.5] clamp safety story, and the calibration loop via `ai_forecast_outcomes`. **Trigger to resume**: owner explicitly references the doc. Don't propose proactively before then.
>   • **Phase D watch STILL active until 2026-06-07** (carried over from Session 22). Three signals: (1) Vero `needs_review_agreement_pct` vs 46.8% baseline, (2) queue depth trend, (3) normalization re-confirm rate. The M112+M113 sweeps + Vero backlog cleanup all shipped during the watch — their effects will fold into the 2026-06-07 read. Ticket 2 voucher cache re-warm still parked until after the watch ends.
>   • **M114 — `recipes.method text` (nullable)** for free-form chef preparation/cooking instructions. Owner edits inline via `MethodEditor` textarea below the YieldEditor in the recipe drawer (autosaves on blur when dirty). AI bulk importer extracts method from source files into this field at create time; capped 20k chars at PATCH + extractor write. Not used in cost/margin math — purely operational metadata.
>   • **`/api/inventory/recipes/import-parse` accepts THREE input modes now.** (a) JSON `{ menu_text }` — text paste, unchanged. (b) multipart `file=*.pdf` — Sonnet vision document content block (same pattern as `pdf-extractor`). (c) multipart `file=*.docx` — server-side `mammoth.extractRawText` → text → Sonnet. (d) multipart `file=image/*` — Sonnet vision image content block. Old `.doc` binary NOT supported; owner re-saves as `.docx`. Cost rises to ~$0.25/parse on vision call (was ~$0.10 text-only) — quota-counted.
>   • **Sub-recipe detection in bulk import — two-pass save.** SYSTEM_PROMPT teaches Sonnet to emit `is_subrecipe: true` + `yield_amount`/`yield_unit` on preparations the source defines once (sauces / doughs / stocks) and to reference them from parent dishes via `{ "sub": "<exact-name>", "qty", "unit" }` instead of a product prefix. Output's ingredient shape is a discriminator union: `{ kind: 'product', product_id, … } | { kind: 'sub', sub_name, … }`. UI `BulkImportModal` saveAll() processes sub-recipes first (builds a lowercased name→id map), then parents (resolves each `sub` to `subrecipe_id`). UI preview renders sub-recipe cards with a lavender SUB badge + grey background; price field hidden for subs; yield read-out shown inline; sub references in parent ingredient lists get a small `SUB` pill. Cycle prevention is the existing recipe-cost engine's responsibility — the importer just creates rows.
>   • **`isDish()` on `/inventory/recipes` recognises typed-but-priceless recipes as dishes.** Filter: a recipe is a "dish" if it has `selling_price_ex_vat > 0` OR `menu_price > 0` OR a **dish-shaped type** (starter / main / pasta / pizza / dessert / drink / cocktail / side). The `sauce` type and `null` type stay in the sub-recipes bucket. This caught a real bug 2026-06-01: bulk-imported starter with no printed menu price was landing in sub-recipes even with `type='starter'` set. Bulk-importer prompt + draft pipeline now also extract dish `type` (`'starter'|'main'|'pasta'|'pizza'|'dessert'|'drink'|'cocktail'|'side'|'other'`) per dish; sub-recipes always get `type=null` regardless.
>   • **M115 — BAS → operator-bucket dictionary** at `lib/overheads/basBuckets.ts`. 87 BAS account codes mapping to 35 operator-readable subcategories (rent / utilities / cleaning / repairs / marketing / salaries / payroll_tax / pension / it_software / consulting / bank_fees / dine_in / alcohol / etc.). Mirror in `sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql` as a CASE WHEN — **MUST stay in sync**. Backfilled ~611 NULL-subcategory `tracker_line_items` rows across both businesses post-COMMIT 2026-06-01. **VAT-hotfix invariant preserved: account 3053 is DELIBERATELY unmapped** — 6 % VAT never implies takeaway (only explicit Wolt/Foodora/UberEats platform names map there). Persistent rule at both `app/api/fortnox/apply` insert sites: `subcategory: l.subcategory ?? bucketForAccount(l.fortnox_account)?.sub ?? null` — AI's value wins when set; dictionary fills when AI left blank; honest-incomplete (null) when neither.
>   • **`/overheads` SubcategoryBreakdown now renders real buckets without UI change.** The /api/overheads/line-items consumer filters `category === 'other_cost'` upstream of the rollup, so revenue subcategories (dine_in/alcohol/takeaway/other_revenue on 3xxx rows) and food_cost subcategories never pollute the overhead view. The dictionary covering revenue is coherent BY CONSTRUCTION — no presentation grouping needed.
>   • **Pre-COMMIT verification of any BAS dictionary change is by spend, not row count.** Caught two real mis-maps during M115's pre-COMMIT verification (`3053 → takeaway` would have undone the VAT hotfix; `6800 → memberships` was wrong for Vero's "Inhyrd personal" agency-staff usage at 144k SEK/year). Pattern: `scripts/diag-bucket-backfill-verify.mjs` applies dict in-memory + outputs (a) by-bucket spend totals per business, (b) top-15 accounts by spend with bucket assignment, (c) category × bucket coherence check, (d) unmapped long-tail. If you ever extend the dictionary, re-run that diag and eyeball top-15 against sample labels.
>   • **Three investigation deliverables in `docs/investigation/` from 2026-06-01.** (1) `invoice-organisation-plan.md` — central thesis: categorisation is ~95 % read-and-roll-up via BAS (Fortnox already did it); restaurants use a TINY ~19-account working chart per business. (2) `coverage-checks.md` — Chicce 23.6 % BAS coverage is structural (PDF-driven), not back-fill-pending; 82 % of no-BAS lines are product-matched → recipe foundation clean. M&S no_pdf is actually a **supplier-DIVERSE 452-invoice class** (not just Martin Servera); recovery rate unknown locally, owner Fortnox-UI spot-check of 20-invoice sample is the size-decision. (3) `overhead-bucket-dictionary-step0.md` + `verify.md` — the build itself, with by-spend believability check baked in.
>

> **Session 22 invariants (2026-05-30/31, P2.0 + Gate-0 precedence + reliability paydown):**
>   • **`lib/inventory/matcher.ts` Gate 0 is a four-signal precedence with safeguards on 0c+0d.** 0a per-business `supplier_classifications` override (M083) always vetoes. 0b description rule (`lib/inventory/description-rules.ts`) always vetoes (structural — pallets/deposits never products). 0c global supplier dict + 0d fallthrough_unknown both gated on `hasOwnerConfirmedAlias` — owner_confirmed alias at (business, supplier, normalised_description) overrides the auto-veto. Fuzzy aliases NOT protected (machine guesses, audit queue's job to catch). Don't broaden the safeguard to other match_methods or via product_id — that suppresses the self-healing signal. See `project_p20_gate0_precedence_principle` memory.
>   • **`lib/inventory/suppliers.ts` EXACT_OVERRIDES holds only suppliers whose meaning is identical at every business.** Multi-purpose suppliers live in per-business `supplier_classifications` (M083), NEVER in the global dict. Two confirmed category errors removed: Frimurarholmen AB (landlord + food passthrough at Vero), BARKONSULT Jakobsson & Lövgren AB (sells bar equipment + glassware + spirits despite consultancy-sounding name). Before adding any new EXACT_OVERRIDES entry, eyeball actual invoice descriptions for multi-purpose patterns. Top-of-file comment carries the rule.
>   • **Multi-purpose-supplier hunt produces candidates, not verdicts.** `scripts/diag-gate0-fix1-hunt.mjs` surfaces lines where supplier-veto fires AND BAS gives positive food/alcohol. The signature has two opposite causes: mis-globalized supplier (fix dictionary) OR miscoded invoice (fix accounting). Only a description-level human eyeball distinguishes. NEVER automate "remove from dict on contradiction" — Fortnox AB case (22 SaaS lines miscoded to 4xxx food) would have been wrong-flipped under auto-resolve.
>   • **`lib/inventory/description-rules.ts` is the canonical deposit/logistics/rebate pattern.** Matcher Gate 0b consumes it. New arms MUST be `^token\M`-anchored (start-of-string + word boundary) and pass a both-directions check in the dry-run before shipping: A=catches the noise it's meant to; B=does NOT catch real products whose description merely contains the token. The "Varav pant per enhet" annotation on Coca-Cola lines is the cautionary example. Unanchored compound arms (avtalsrabatt, pantersättning, öresavrundning, faktureringsavg, inkassoarvode, påminnelseavg) are safe because the compound words don't appear inside real product names; Avtalsrabatt specifically can be a SUFFIX on product-named credit lines and is correctly caught there.
>   • **`/api/inventory/lines/rematch` self-chains across Vercel's 800s wall.** Cursor-based pagination via `id > p.cursor ORDER BY id LIMIT 500` (NOT offset — matched rows drop out of the predicate); checkpoint + flip state to 'pending' + POST self with `{ resume: true }` + Bearer CRON_SECRET; `MAX_RESUMES = 30`. Mirrors `lib/inventory/backfill-worker.ts`. `/api/cron/inventory-rematch-business` is a thin proxy to the patched worker (don't reintroduce a separate worker — that drift was the bug). See `feedback_rematch_worker_self_chain` memory.
>   • **`lib/fortnox/extract-voucher-ref.ts` is the shared SUPPLIERINVOICE-ref extractor.** Used by the supplier-sync cron at write time; mirrored exactly in `sql/p20-paydown-ticket1-backfill-APPLY.sql` for the one-time backfill. Filter `ReferenceType='SUPPLIERINVOICE'` is load-bearing — each invoice carries SUPPLIERINVOICE (booking) + SUPPLIERPAYMENT (payment) refs; grabbing the wrong one silently resolves future joins to the wrong voucher. If you change the filter in the TS helper, change it in the SQL too — drift produces inconsistent column values depending on whether a row was migrated or freshly written.
>   • **`supplier_invoice_lines.account_source` distinguishes provenance** (M108): `'fortnox_row'` (Fortnox posted account at receipt time), `'voucher_backfill'` (P2.0 inferred from voucher), `'owner_correction'` (admin UI — reserved for future). Use it in audits to separate Fortnox-native data from inferred data.
>   • **`inventory_review_outcomes.context = 'rebate_guard_backfill'`** is the auto-correction marker (vs `'needs_review'` runtime owner action and `'audit_sample'` spot-check). D3 accuracy snapshot segments by context — don't blend.
>   • **P2.0 Op 2c demotion firing pattern.** Atomic correction = clear alias + insert outcome row + call `product_aliases_record_correction(alias_id, 2)` RPC. Mirrors runtime `/correct-attribution` path. SQL backfills that clear aliases MUST also fire the RPC, else `corrections_against` drifts from outcome rows and D1 demotion threshold misfires on future corrections.
>   • **Phase D watch active until 2026-06-07.** Three signals: (1) Vero `needs_review_agreement_pct` vs 46.8% baseline, (2) queue depth trend, (3) normalization re-confirm rate (owners re-confirming same product with different supplier-string variant). Trickle on (3) = current safeguard right permanently; volume = `normalise.ts` is too strict (real fix is upstream, NOT a product_id safeguard). Don't ship Ticket 2 voucher cache re-warm during the watch — its ~2,354-line rescue ceiling would confound the queue-drain signal.
>   • **VAT hotfix verified 2026-05-31.** `lib/sweden/vat.ts` + 5 inference sites all carry the "VAT rate never implies sales channel" principle. Vero account 3053 (48,468 SEK) correctly unclassified post-fix (`subcategory=null`, not 'takeaway'). Chicce clean (no 6% accounts). See `docs/investigation/vat-hotfix-status.md`. Don't reintroduce `6%→takeaway` anywhere — only explicit Wolt/Foodora/UberEats platform names map to takeaway.
>
> **Session 21 invariants (2026-05-25, scaling audit + risk-horizon hardening):**
>   • **Anthropic calls go through `lib/ai/anthropic-fetch.ts` — no raw fetch.** Shared helper with Retry-After + exponential backoff on 429/5xx + 4 max retries (~30s worst case). Returns discriminated union `{ ok: true, json, tokensIn, tokensOut, cacheRead, cacheCreate, ... } | { ok: false, status, errorText, ... }`. Already wired into `/api/scheduling/ai-recommend` and `/api/inventory/review/ai-suggest`. Any NEW Anthropic surface MUST use this — don't reintroduce raw `fetch('https://api.anthropic.com/v1/messages')`. Pattern in `lib/inventory/pdf-extractor.ts:778-816` is the historical original; this is the extracted shared version.
>   • **AI quota gate is mandatory on user-triggered endpoints.** `checkAndIncrementAiLimit(db, auth.orgId)` returns `LimitGate` (`{ ok: true, ... } | { ok: false, status, body }`); on `!ok` return `NextResponse.json(usage.body, { status: usage.status })`. Cron-driven workers use the lighter `checkAiLimit` (no increment — `logAiRequest` ticks the counter separately). Sites currently gated: `/api/ask`, `/api/scheduling/ai-recommend`, `/api/inventory/review/ai-suggest`, `/api/fortnox/extract-worker` (via checkAiLimit), `/api/reviews/draft-reply`, `lib/forecast/llm-adjust.ts`. Default `MAX_DAILY_GLOBAL_USD=150` (was 50, would have fired daily at 20 customers). Memory: `feedback_anthropic_sdk_outdated` for the SDK-version trap.
>   • **`requireBusinessAccess(auth, businessId)` on EVERY route that accepts business_id.** Routes that read `business_id` from query/body MUST verify the caller's org owns that business — else cross-tenant leak. Confirmed coverage 2026-05-25: 3 Fortnox routes had been missing it (`recent-invoices`, `drilldown`, `integrations/generic` — all fixed). Pattern: read `business_id`, validate present, then `const forbidden = requireBusinessAccess(auth, businessId); if (forbidden) return forbidden`.
>   • **`lib/fortnox/api/fetch.ts` caps concurrency to 2 in-flight per access token.** Module-level `Map<tokenKey, count>` semaphore; tokenKey is `accessToken.slice(0, 16)` (sufficient to distinguish customers, never logged). Acquire-before-fetch, release-in-finally. Without this, master-sync fan-out via Promise.all hits Fortnox's per-token rate limit at 20-customer scale. Caller code unchanged — the helper transparently serialises.
>   • **`lib/sync/aggregate.ts:35 LOCK_STALE_MS = 180_000` (was 60).** Master-sync `maxDuration = 300`; a 60s TTL meant slow runs could have their aggregation lock stolen mid-write → stale `monthly_metrics` overwrites. Don't lower this without also lowering the master-sync maxDuration.
>   • **`master-sync` returns 206 + emails ops when per-customer error rate ≥30%.** Previously errors were silently swallowed in the `Promise.all` results. New `lib/email/ops-alert.ts` helper sends plain-text via Resend to `OPS_ALERT_EMAIL` env (defaults `paul@comandcenter.se`). When adding new cron jobs, use the same helper for consistent alert formatting.
>   • **`scheduling-sync` uses `filterEligible()` not hardcoded status filter.** Same eligibility logic as master-sync — `needs_reauth` integrations get probed once per 6h cooldown so they auto-recover. Don't reintroduce `.in('status', ['connected', 'warning'])` patterns; use the helper.
>   • **`/api/cron/extraction-sweeper` returns 200 (not 500) on RPC failure.** Was infinite-retrying via Vercel cron-retry, racing with in-flight sweeps. Now returns `{ ok: false, will_retry_on_next_cron: true }` and lets the next 2-min tick handle the natural retry. Belt-and-braces: M101 hardened `list_ready_extraction_jobs` RPC with `FOR UPDATE SKIP LOCKED`.
>   • **Stripe webhook uses two-phase claim pattern (M103).** `claim_stripe_event(event_id, event_type, stale_ms)` returns `'claimed' | 'duplicate' | 'concurrent' | 'stale_takeover'`. `'concurrent'` (<60s) → return 429 (Stripe retries). `'stale_takeover'` (>60s, never processed) → rerun handler. `mark_stripe_event_processed` only called AFTER handleEvent succeeds. Closes silent-underbilling on Vercel function-kill. Handlers must remain idempotent on Stripe data (subscription.* events are end-state writes — already idempotent).
>   • **Every `sendEmail` carries an `Idempotency-Key` header.** `lib/email/send.ts` auto-derives sha1(from|to|subject|first-400-html) if caller doesn't pass `idempotencyKey`. Resend dedups identical sends in a 24h window — covers Vercel function-retry double-fires. Callers needing stronger semantics (cron daily digests, post-payment receipts) should pass an explicit `idempotencyKey: \`digest:${date}:${orgId}\``.
>   • **`logAiRequest()` MUST be called by every Anthropic surface.** Powers cost dashboard + global kill-switch denominator. Confirmed coverage 2026-05-25: `pdf-extractor` and `inventory/review/ai-suggest` were missing it (~$1.50/mo/customer hidden); now both call it. New AI surfaces fail audit if they don't.
>   • **`ai_request_log_archive` (M102) preserves audit trail past 365 days.** Weekly retention cron archives per-day aggregates (`date × org_id × request_type × model`) via `upsert_ai_log_archive` RPC BEFORE deleting source rows. Aborts run on archive failure — never deletes unarchived data. ~99% smaller than raw rows; safe for 7+ years of retention.
>   • **Use `Z` from `lib/constants/tokens.ts` for z-index, not raw numbers.** Scale: `sticky(10) / rail(20) / banner(50) / dropdown(100) / backdrop(199) / modal(200) / tooltip(300) / toast(400)`. Audit found 50/100/199/200/1000 raw values scattered — predictable stacking now lives in the token.
>
> **Session 20 invariants (2026-05-24, inventory pipeline & recipe cost):**
>   • **Unit conversion lives in `lib/inventory/unit-conversion.ts` + `lib/inventory/recipe-cost.ts`.** Recipe ingredient quantity converts into the product's `base_unit` (g/ml/st) via `convertQuantity` (mass↔mass, volume↔volume; cross-family returns null + unit_mismatch flag). `cost_per_base_unit = unit_price / pack_size`. Without `pack_size` set, the helper falls back to `parseProductPackSize(product.name)` (regex matches "4,1 kg" / "500ml" / "30 st"); if that fails too, legacy 1:1 calc + warning. Bulk backfill at `/api/inventory/items/backfill-pack-size` walks every null-pack product and applies the parser in one click. `createProductFromLine` in matcher.ts auto-fills pack_size when bulk-review creates a new product.
>   • **Recipes can include sub-recipes (M086).** `recipe_ingredients.subrecipe_id` UUID FK, CHECK exactly-one-of (product_id, subrecipe_id), ON DELETE RESTRICT on subrecipes. Cost recursion via `loadRecipeIndex` (full business → Map) + ancestor-stack cycle detection in `computeRecipeCost`. Three layers of cycle prevention: DB CHECK (self-ref), POST endpoint `wouldCreateCycle` walker, compute-time skip+flag. `/inventory/recipes` drawer drills via "→" with a back-stack so closing returns to the parent.
>   • **PostgREST `.upsert({ onConflict })` does NOT work against partial unique indexes.** Memory file `feedback_postgrest_upsert_partial_indexes.md` documents this; I've hit it 3× (product_aliases M075, recipe_ingredients post-M086 product path AND subrecipe path). Pattern: SELECT-first-then-INSERT, retry-SELECT on 23505. Audit done 2026-05-24; no other offenders remain in inventory code. Before ANY new `.upsert({ onConflict })`, check if the target index is partial or has expression columns.
>   • **Currency tracking is end-to-end (M085 + M088).** `supplier_invoice_lines.currency` defaults SEK; PDF extractor detects from invoice header; `lib/inventory/fx.ts` + daily ECB cron at `/api/cron/fx-rates-update` populate `fx_rates`. Cost reader gets `latest_price_sek` via `getProductLatestPrices(db, biz, ids, fxIndex)`. NON-SEK lines without an FX rate get `latest_price_sek = null` and the cost reader treats them as missing-price (rather than silently using native currency). Every recipe/catalogue endpoint that builds priceMap MUST pass the fxIndex — otherwise EUR/USD costs revert to native currency and silently 11× / 10× error.
>   • **Per-business supplier overrides (M083).** `supplier_classifications(business_id, supplier_fortnox_number, classification='not_inventory')`. Matcher gate-0 checks this BEFORE BAS-account routing AND BEFORE universal supplier-name classifier — owner judgement wins. UI: "Skip ALL from supplier" button on `/inventory/review` + admin view at `/inventory/skipped` for Restore. Future scope: extend `classification` CHECK to allow category overrides (e.g. "always food from supplier X") if needed.
>   • **Inventory product editability is now everywhere it should be.** Name/category/unit/pack_size/base_unit editable from `/inventory/items/[id]` header. Per-line qty/unit/price/total/currency editable from the same page's history table. Product-level fields ALSO editable inline from `/inventory/recipes` drawer's "✎ edit product" expand per ingredient. Don't add another product-edit surface — extend the existing PATCH `/api/inventory/items/[id]` + PATCH `/api/inventory/lines/[id]` and surface from these two pages.
>
> **Session 18 invariants (2026-05-08):**
>   • **`lib/sync/aggregate.ts` must include scheduled PK rows in the staff_logs SELECT, with in-memory dedupe.** Do NOT reintroduce `.not('pk_log_url', 'like', '%_scheduled')` at the SELECT layer. PK keeps shifts in scheduled state until end-of-day close — during trading hours, scheduled rows (`estimated_salary > 0`, `cost_actual = 0`) are the only cost data that exists for today. Filtering them at SELECT zeros today's `daily_metrics.staff_cost` until evening, the dashboard tile reads empty, and only end-of-service viewers ever see the bug fix itself (which is why this lurked undetected). Dedupe is by `(pk_staff_url, shift_date)` — if a logged sibling exists for that key, drop the scheduled twin so a same-day flip doesn't double-count. Memory: `feedback_aggregator_scheduled_shifts.md`. Applied to BOTH the daily-aggregation loop AND the dept_metrics loop in aggregate.ts.
>
> **Session 17 invariants (2026-05-07, Fortnox OAuth + backfill + drilldown):**
>   • **OAuth state is base64url, not base64.** `signState`/`verifyState` in `app/api/integrations/fortnox/route.ts` use `Buffer.toString('base64url')` for both body and signature halves. Standard base64 contains `+` chars; URL-encoded `+` decodes to space (WHATWG `URLSearchParams` form-decode rule), so a base64 sig with a `+` byte arrives at the callback with that byte mangled to ` ` and HMAC verification fails. Same pattern as JWT. Memory: `feedback_fortnox_oauth_state_encoding.md`. **Don't reintroduce `'base64'` here** — anywhere that signs and ships data through a URL must use `'base64url'`.
>   • **`/api/integrations/fortnox?action=connect` URL must carry `&business_id=`.** `app/integrations/page.tsx:460` calls `connectFortnox(selectedBiz)` and the button is `disabled={!selectedBiz}` — empty `business_id` produces NULL in the upsert and `(business_id, provider)` partial-unique-index can't dedup NULL rows. Admin concierge token at `/api/admin/oauth-link` similarly: `business_id` must be set on the signed payload, else the same NULL bug returns. Memory: `feedback_fortnox_business_id_required.md`.
>   • **`integrations` upsert uses `onConflict: 'org_id,business_id,provider'`** — the non-partial unique index added by M049 (`integrations_org_biz_provider_uniq`). The pre-existing partial indexes on the table (`WHERE department IS NULL`, `WHERE business_id IS NOT NULL`, expression-based `COALESCE`) are NOT usable by PostgREST `onConflict` — only non-partial constraints/indexes match by column list. New code that upserts integrations must use this same conflict key.
>   • **PDF apply path is canonical for `tracker_data`. API backfill defers.** The 12-month backfill worker at `/api/cron/fortnox-backfill-worker` writes `source='fortnox_api'`, `created_via='fortnox_backfill'`, but skips months where a `source IN ('fortnox_pdf','fortnox_apply')` row already exists. PDF apply ran the M047 validators + AI auditor + owner review — that human review is preserved by skipping. Don't flip API priority without also wiring API rollups through the same chokepoint. Memory: `feedback_fortnox_backfill_pdf_priority.md`.
>   • **`archive/migrations/*.sql` are NOT authoritative for prod schema.** `archive/migrations/supabase_schema.sql` declares constraints that don't exist in production (e.g. the `UNIQUE(business_id, provider)` on `integrations` was never applied). When a constraint claim is load-bearing, query `pg_indexes` / `pg_constraint` directly via Supabase — don't trust files under `archive/`. The 2026-05-07 OAuth-chain debug burned an hour because of this. Memory: `feedback_archive_migrations_not_authoritative.md`.
>   • **Drill-down from cost flag → supplier invoices is owner-facing.** `/overheads/review` flag cards have a "Show invoices" expansion that calls `/api/integrations/fortnox/drilldown`. Server-side cache `overhead_drilldown_cache` (M051) keyed on `(business_id, year, month, category)` — 5-min TTL for UI, 30-min stale window for the AI explain endpoint to opportunistically enrich its prompt. Live data, no eager voucher storage. PDF proxy at `/api/integrations/fortnox/file` streams attached invoice PDFs with `Content-Disposition: inline`.
>   • **AI surfaces must obey SCOPE_NOTE's invoice-data rule.** Per-supplier-invoice voucher detail is NOT in standard AI context — only fetched on-demand via the drill-down. Any AI surface that imports `SCOPE_NOTE` (`lib/ai/scope.ts`) inherits the constraint: must NOT fabricate specific invoice claims; MAY mention the drill-down affordance as a next step; MAY cite specifics ONLY when explicitly given them in the prompt (e.g. via the warm-cache enrichment in `app/api/overheads/explain/[flagId]/route.ts`).
>
> **Session 16 invariants (2026-05-03, data-source guardrails):**
>   • **Aggregator revenue dedup is per-date and source-priority-aware.** `lib/sync/aggregate.ts` picks ONE full-business aggregate provider per date in priority order (`personalkollen > onslip > ancon > swess`); per-dept slices (`pk_*`, `inzii_*`) sum legitimately across departments. Pre-fix the dedup only handled `personalkollen` vs `pk_*` — Vero March 2026 surfaced 2× revenue inflation when other aggregates stacked. Adding a new POS connector: append to `FULL_AGGREGATE_PROVIDERS` if it's a full-business aggregate, or use `<name>_<dept>` provider names if per-department. Memory: `feedback_aggregator_dedup_pk_agreement.md`.
>   • **PK staff_cost requires coverage AND agreement before it wins.** `lib/sync/aggregate.ts` checks (a) oldest PK `staff_log.shift_date` predates the period, AND (b) PK total is within 70–130 % of Fortnox total when both have data. Outside the band → use Fortnox with `cost_source='fortnox_pk_disagrees'`. The `_disagrees`/`_partial` codes drive admin alerts via `lib/admin/disagreements.ts` + the daily cron. Source-agnostic — Caspeco/Onslip equivalents plug in by adding their codes to `COST_KIND_BY_SOURCE`.
>   • **Single chokepoint for Fortnox apply: validators + AI auditor BEFORE any tracker_data write.** `app/api/fortnox/apply` runs `validateExtraction()` (10 rule-based checks) + `auditExtraction()` (Haiku second-opinion). Returns HTTP 422 with `kind='validation_blocked'` + structured `blocking_errors` / `warnings_to_ack` / `ai_audit`. UI acks via `acknowledged_warnings: string[]` + `force: true`. HARD errors (`override_allowed: false`) are never overridable — currently `org_nr_mismatch` and `period_mismatch`. New checks go in `lib/fortnox/validators.ts` as a `CheckFn` appended to `CHECKS[]`. Memory: `feedback_fortnox_apply_guardrails.md`.
>   • **tracker_data writes MUST tag `created_via`.** M047 added the column. `'fortnox_apply'` from the validated pipeline; future writers (`'owner_form'`, `'admin_backfill'`, `'migration'`) tag explicitly. The daily `/api/cron/manual-tracker-audit` finds rows with `source='manual' AND fortnox_upload_id IS NULL` (the Rosali March 2026 class) and emails ops. DB CHECK constraints + `pdf_sha256` dedup are defence in depth.
>   • **Two daily ops emails (06:30 + 06:45 UTC) catch what the rule engines miss.** `data-source-disagreements-alert` digest of monthly_metrics rows touched in last 24h with disagreement codes; `manual-tracker-audit` for rogue manual rows. Both source-agnostic — when new POS connectors / new write paths land, the same pipelines pick them up without code changes.
>
> **Session 15 invariants (2026-05-02, onboarding + auth + holidays):**
>   • **next-intl client hooks MUST live inside `<NextIntlClientProvider>`.** Any component calling `useTranslations` / `useLocale` / `useFormatter` is a child of the provider in `app/layout.tsx`, never a sibling. Sibling placement breaks SSR with a wrapper-masked `Error(void 0)` on every page (the next-intl runtime catches the real error and rethrows anonymously). 2026-05-01 incident: `<CookieConsent />` was outside the provider → every route 500'd. Memory: `feedback_next_intl_provider_scope.md`. Defensive layer: `i18n/request.ts` wires `onError` + `getMessageFallback` so future failures log a useful `[next-intl] CODE: msg` line and missing keys render as `{ns.key[CODE]}` instead of crashing. Layout itself has `export const dynamic = 'force-dynamic'` + try/catch around `getLocale()/getMessages()` so the gate degrades gracefully.
>   • **Onboarding owns ALL business-data capture; signup is minimal.** Signup form takes only email + password + full name + org name (4 fields, ~30s). Onboarding's Restaurant step takes address, organisationsnummer (validated via `lib/sweden/orgnr.ts`), business stage (new/established_1y/established_3y), opening days (Mon–Sun), cost targets. Optional last-year P&L PDF on the Systems step (only when stage ≠ 'new'). Wizard is 3 actual steps now (Restaurant → Systems → Done) — the marketing welcome slide was removed. Org-nr is stored at `organisations.org_number` via the shared helper `lib/sweden/applyOrgNumber.ts` which both `/api/onboarding/complete` and `/api/settings/company-info` POST through (single source of truth for DB write + Stripe metadata + tax_id sync).
>   • **Two-gate AppShell: OnboardingGate BEFORE PlanGate.** `components/AppShell.tsx` renders OnboardingGate first; it redirects to `/onboarding` when the wizard isn't finished. PlanGate fires second (only if onboarding is complete) and redirects to `/upgrade` for unpaid orgs. Both gates skip their check on a shared open-paths list (`/onboarding`, `/settings`, `/upgrade`, `/privacy`, `/terms`, `/security`, `/login`, `/reset-password`, `/api`). The order is load-bearing — swapping them sends unfinished owners to `/upgrade` with no business set up. OnboardingGate treats the org as "completed" if EITHER `onboarding_progress.completed_at` is set OR the org has at least one `business` row (so legacy customers don't get surprise-redirected). Endpoint: `/api/me/onboarding`.
>   • **Email verification is mandatory at signup.** `app/api/auth/signup` creates auth users with `email_confirm: false` and immediately calls `lib/email/sendVerifyEmail.ts` which generates a Supabase confirmation link via `auth.admin.generateLink({type:'signup', options:{redirectTo: …/api/auth/callback?next=/onboarding}})` and emails it through Resend with our branded HTML + locale-aware copy. The signup form no longer auto-signs-in; it shows a "Check your inbox" screen. The callback route exchanges the code for a session and redirects to `/onboarding`. Best-effort: missing `RESEND_API_KEY` flags `verificationSent:false` in the response so the UI can surface a non-blocking warning instead of crashing.
>   • **OrgNumberGate + OrgNumberBanner are deleted.** Onboarding now requires org-nr upfront, so the 30-day grace banner + hard lockout are dead code. `components/OrgNumberGate.tsx` and `components/OrgNumberBanner.tsx` are gone; `misc.orgGate` and `settings.orgNumberBanner` keys removed from all 3 locale JSONs. Existing customers without org-nr fall through `OrgNumberGate`'s old "completed_at OR has-business" logic and can still set the value via `/settings/company`. Don't reintroduce a grace gate.
>   • **Holidays are pure-compute, country-routed, no DB.** `lib/holidays/sweden.ts` calculates 17 SE restaurant-relevant days per year via the Anonymous Gregorian algorithm (Easter) + fixed dates + "first weekday in window" (Midsummer + All Saints'). `lib/holidays/index.ts` exposes `getHolidaysForCountry(country, year)` and `getUpcomingHolidays(country, fromDate, daysAhead)` — Norway / UK plug in as sibling files later, no overlap. Country resolves via `businesses.country` (default 'SE'). Endpoint: `/api/holidays/upcoming`. Wired into: AttentionPanel card on `/dashboard` (next holiday inside 14 days), red weekend/holiday X-axis labels in OverviewChart, weekly memo prompt (`lib/ai/weekly-manager.ts`, 21-day window) and scheduling-optimization cron (28-day window).
>   • **DB column M046 — `businesses.opening_days` JSONB + `businesses.business_stage` TEXT.** Default opening_days = open every day; business_stage NULL allowed for legacy. `business_stage` enum guard via CHECK constraint. Both fields written by `/api/businesses/add`; both read by AI agents that care about scheduling and budget anchoring (the budget-AI's "stage = new → skip historical-anchor rule" path will land in a follow-up).
>
> **Session 14 invariants (2026-04-27, Sprint 1 remediation):**
>   • **Authenticated routes are gated by `middleware.ts`.** Cheap structural JWT validation (no crypto, no Supabase network call) on an explicit allowlist of 17 protected prefixes. Cryptographic check stays in `getRequestAuth`. Excludes `/admin/*` (own auth), `/login`, `/reset-password`, `/terms`, `/privacy`, `/api/*`, Next internals. Logged-in `/` → `/dashboard`. Cookie-parsing util lives in `lib/auth/session-cookie.ts` and handles all three @supabase/ssr storage shapes including chunked cookies. Don't bypass — every new authenticated route inherits the gate via the prefix list, but only if you ADD it to `isProtectedPath`.
>   • **Multi-org membership is deterministic-by-earliest until explicit selection ships.** Both auth helpers (`lib/supabase/server.ts` + `lib/auth/get-org.ts`) use `.maybeSingle()` with `.order('created_at', { ascending: true }).limit(1)` on `organisation_members`. A user belonging to ≥2 orgs no longer 401s; they land in their oldest membership. Future work (cookie or query-param org switcher) is the only acceptable replacement — do not regress to `.single()`.
>   • **Fortnox supersede chain lives in `fortnox_supersede_links` (M032), not the column.** apply() inserts one row per period iteration (`(child_id, parent_id, year, month)`); reject() walks the table to restore EVERY parent on multi-month uploads. The column-level `supersedes_id` / `superseded_by_id` on `fortnox_uploads` stays for backwards compat (single-month accuracy + reject fallback for pre-M032 chains) but the join table is the source of truth. Don't read the columns in new code — query the link table.
>   • **AI quota gate is atomic on user-facing endpoints (M033).** `/api/ask` and any new burst-sensitive caller MUST use `checkAndIncrementAiLimit()` from `lib/ai/usage.ts` — atomic INSERT … ON CONFLICT DO UPDATE via `increment_ai_usage_checked` RPC, decrements on over-limit so rejected attempts don't tick the counter. Cron-driven AI agents may keep using the legacy `checkAiLimit` + `incrementAiUsage` (now `@deprecated`) since they run serially under cron locks. Global kill-switch denominator now comes from `ai_spend_24h_global_usd()` RPC — never re-introduce `db.from('ai_request_log').select(...).gte('created_at', since)` table scans.
>
> **Session 13 invariants (2026-04-26):**
>   • **Single writer, trusted reads.** `lib/finance/projectRollup.ts` is the only function that turns extracted Fortnox data into a `tracker_data` row. /api/tracker, the Performance page, and the aggregator all read the persisted values verbatim — no recompute. If the formula changes, change `projectRollup` + re-apply existing extractions (their `extracted_json` is immutable, projection is idempotent).
>   • **Sign convention lives in `lib/finance/conventions.ts` and nowhere else.** Storage uses: revenue positive, costs positive, financial signed (negative = interest expense). `net_profit = revenue − food − staff − other − depreciation + financial`. Display layer translates if it needs different signs.
>   • **Swedish VAT rates ARE the revenue classifier.** 25 % = alcohol, 12 % = dine-in food, 6 % = takeaway (Wolt / Foodora / Uber Eats). Storage columns: `dine_in_revenue`, `takeaway_revenue`, `alcohol_revenue` — each a subset of `revenue`, never additive. `classifyByVat` in extract-worker enforces this; downstream readers trust the rollup. Don't lump 6 % into food anywhere.
>   • **Resultatrapport extraction: parser first, LLM fallback.** `lib/fortnox/resultatrapport-parser.ts` is the canonical extractor for Fortnox Resultatrapport PDFs (deterministic, ~100 ms, free). Claude only runs when the parser fails or returns low confidence. Both share the classifiers in `lib/fortnox/classify.ts` so rules can't drift between paths. Test against real PDFs via `npx tsx scripts/test-fortnox-parser.ts path/to/report.pdf`.
>   • **fortnox_uploads supersede chain.** Re-uploading a corrected PDF for the same period marks the old upload `status='superseded'` and links via `supersedes_id` / `superseded_by_id`. Line items cleared by `source_upload_id` (NOT period_month — that filter was the multi-month reject bug). Reject walks the chain backwards: predecessor restored to 'applied'.
>   • **PK sync `needs_reauth` auto-probe.** Every sync entry point uses `lib/sync/eligibility.ts::filterEligible()`. Includes connected + due-for-probe needs_reauth (last attempt > 6 h). Don't filter `.eq('status','connected')` directly anywhere new.
>
> Infra plans (as of 2026-04-23):
>   • Supabase: **Pro** — daily backups, PITR, 8GB DB, no-pause
>   • Vercel: **Pro** — sub-daily crons, Rolling Releases, preview password protection
>   • GitHub: Free (fine at current scale)
>   • Email: Gmail Workspace on `comandcenter.se` — paul@ mailbox + 11 aliases, SPF/DKIM/DMARC all PASS
>
> Key additions (2026-04-23, session 12):
>   • New page: `/financials/performance` — unified Revenue / Food / Labour / Overheads / Net-margin view with Week/Month/Quarter/YTD granularity, period picker, compare dropdown, waterfall + donut + trend sparklines + "What's tunable" attention panel. Replaced the dead `/cashflow` route entirely.
>   • AI layer upgrade: `lib/ai/rules.ts` (shared benchmarks / scheduling-asymmetry / voice / forecast-anchor), tool-use replaces regex-JSON on 4 agents, prompt caching on /api/ask, `lib/ai/outcomes.ts` + budget_coach feeds the accuracy loop, `lib/ai/contextBuilder.ts` consolidates /api/ask enrichment
>   • PK hardening: `include_drafts=1` (scheduling AI no longer silently empty), timezone-tagged timestamps (endOfDay always emits `Z`), sync cursors (M024 pending), `work_time` net-of-breaks, COGS + staff_uid + sale_center + staff employments captured
>   • Sync engine: resets `status='connected'` on every successful sync (fixes FIXES §0i), typed `PersonalkollenAuthError` → `needs_reauth` + dedup-email (M022)
>   • UX: sticky sidebar, action-pill on scheduling AI, "why is AI advice missing" explanations
>   • Admin: 4 routes locked down (SEC-2026-04-22, FIXES §0g), customer-list cache-bust (§0h), new /admin/diagnose-pk UI
>
> Key architecture additions (2026-04-21 → 22):
>   • Job queue: extraction_jobs + dispatcher/worker/sweeper pattern (M017)
>   • Tenant isolation: RLS on 5 previously-exposed tables + current_user_org_ids() (M018)
>   • Realtime: fortnox_uploads + extraction_jobs pushed via supabase_realtime (M019)
>   • AI learning: ai_forecast_outcomes + capture hook + accuracy reconciler + owner feedback UI (M020)
>   • pg_cron firing extraction worker every 20s + 1-min stale-release (M021)
>   • Extraction rebuilt: Sonnet 4.6 + extended thinking + tool use + prompt caching + validation
>   • Budget AI hardened: historical anchor, current-month rule, data-gap handling, code-level clamps
>   • Billing correctness: stripe_processed_events dedup + org_rate_limits persistence
>   • Reusable helpers: requireAdmin(), orgRateLimit(), withTimeout(), log (structured)
>   • Observability: structured JSON logs across every scheduled cron + hot API route
>   • Data-flow fix: aggregator now merges Fortnox revenue + costs into monthly_metrics;
>     /api/fortnox/apply triggers re-aggregation; /api/admin/reaggregate backfills history
>   • User-scoped queue sweep (/api/fortnox/sweep) — auto-kick stuck jobs from UI

---

## 0. HARD RULE — Update MD Files at Context Limit

**At 95% of context window capacity, Claude MUST:**
1. Update `CLAUDE.md` — session status, any new rules or decisions
2. Update `ROADMAP.md` — what was completed, what is in progress, what is next
3. Update `MIGRATIONS.md` — any SQL run or pending, mark statuses
4. Update `FIXES.md` — any new bugs found or fixed

This is non-negotiable. Do not wait to be asked. Do it automatically before context runs out.

---

## 1. Role Definition

**You are**: Paul Dransfield — business owner, product visionary, decision-maker.
**Claude is**: Technical co-founder and lead developer.
**Dynamic**: You set direction. Claude builds and explains. Always confirms before major changes.

---

## 2. Hard Rules (non-negotiable)

### Auto-push rule
**At the end of every Claude response, all changes are automatically committed and pushed to GitHub.**
This is enforced by a `Stop` hook in `.claude/settings.json` — it runs `git add -A && git commit && git push` after every response if there are any uncommitted changes.

**Why**: Work must always be recoverable from any computer. Context window fills up, sessions end, computers change. GitHub is the source of truth.

**Manually trigger if needed**:
```bash
git add -A && git commit -m "manual checkpoint" && git push
```

---

## 3. Session Protocol (every session, in order)

1. Read `ROADMAP.md` and this file before writing a single line of code
2. Ask clarifying questions if requirements are not clear
3. State the plan — what will be built, why, what you will see — get confirmation
4. Write code with plain-English comments explaining why
5. Explain how to test — specific steps to verify it works
6. Provide SQL for any DB changes, formatted for Supabase SQL Editor
7. Update this file at the end of every session AND at 95% context (see Rule 0)

---

## 3. Project Identity

**Product**: CommandCenter — restaurant group business intelligence SaaS
**Live URL**: https://comandcenter.se
**Stack**: Next.js 14 + Supabase (Frankfurt) + Vercel (EU) + Anthropic Claude API + Stripe + Resend
**Local dev**: C:\Users\pauld\Desktop\comand-center\
**Supabase project**: https://llzmixkrysduztsvmfzi.supabase.co
**Vercel org**: paul-7076s-projects/comand-center

### Key IDs
| Item | Value |
|------|-------|
| Org ID (test org) | e917d4b8-635e-4be6-8af0-afc48c3c7450 |
| Test business 1 (Vero) | 0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99 |
| Test business 2 (Rosali) | 97187ef3-b816-4c41-9230-7551430784a7 |
| Integration 1 | 2475e1ef-a4d9-4442-ab50-bffe4e831258 |
| Integration 2 | 1c3278cc-7446-4fcd-9078-e380c73e52fb |

---

## 4. Architecture — What Is Actually Built

```
Customer browser
      │
      ▼
  Next.js 14 (Vercel EU)
      │
      ├── /dashboard — KPI cards, revenue chart, department breakdown
      ├── /staff — hours, costs, OB supplement, late arrivals
      ├── /departments — cost per department, colour-coded
      ├── /covers — daily revenue detail (rename to /revenue pending)
      ├── /tracker — monthly P&L, manual entry
      ├── /forecast — predicted revenue vs actual
      ├── /budget — cost targets
      ├── /invoices — Fortnox documents
      ├── /alerts — AI-detected anomalies
      ├── /ai — Claude assistant with business context
      └── /admin — customer management (requires ADMIN_SECRET)

      │
      ▼
  Supabase (Frankfurt)
      │
      ├── auth.users — email/password, session cookies
      ├── organisations — customers (multi-tenant root)
      ├── businesses — restaurants within an org
      ├── integrations — Personalkollen, Fortnox, etc.
      ├── staff_logs — shifts, costs, OB supplement, lateness
      ├── revenue_logs — daily revenue, covers, food/drink split
      ├── tracker_data — monthly P&L entries
      ├── forecasts — predicted revenue and costs
      ├── alerts — AI-detected anomalies
      └── ai_usage_daily — query limits per org

      │
      ▼
  External APIs
      │
      ├── Personalkollen — staff data, costs, OB types
      ├── Fortnox — invoices, suppliers (OAuth pending)
      ├── Stripe — billing, subscriptions
      ├── Resend — transactional emails
      └── Anthropic Claude — AI agents and assistant
```

---

## 5. AI Agents — All 6 Built ✅

| Agent | Schedule | Plan | Status | Notes |
|-------|----------|------|--------|-------|
| Anomaly detection | Nightly 06:00 | All | ✅ **COMPLETE** | Updated thresholds, email alerts |
| Onboarding success | On first sync | All | ✅ **COMPLETE** | Sends welcome email on first sync |
| Monday briefing | Monday 07:00 | Pro+ | ⏳ **BLOCKED** | Needs Resend domain verification |
| Forecast calibration | 1st of month | Pro+ | ✅ **COMPLETE** | Runs at 04:00 UTC, pure arithmetic |
| Supplier price creep | 1st of month | Pro+ | ✅ **COMPLETE** | Per-supplier-per-product detection + marquee monthly digest email |
| Scheduling optimisation | Weekly | Group | ✅ **COMPLETE** | Monday 07:00 UTC, uses Sonnet 4-6 |

**Total cost at 50 customers**: ~$5/month using Haiku 4.5 (was $15 with Sonnet — 67% saving)
**Model used**: All agents use `claude-haiku-4-5-20251001` except scheduling optimisation which uses `claude-sonnet-4-6`
**Rule**: Never hardcode model strings — always import from `lib/ai/models.ts`

---

## 6. Database Schema — Key Tables

### Multi-tenant isolation
Every table has `org_id` and `business_id` columns. RLS policies enforce isolation.

### Core tables
- `organisations` — customers (Stripe customer ID, subscription plan)
- `businesses` — restaurants within an org (is_active flag)
- `organisation_members` — users who can access an org
- `integrations` — Personalkollen, Fortnox, etc. (encrypted API keys)

### Data tables
- `staff_logs` — shifts, costs, OB supplement, lateness
- `revenue_logs` — daily revenue, covers, food/drink split
- `tracker_data` — monthly P&L entries
- `forecasts` — predicted revenue and costs
- `alerts` — AI-detected anomalies

### AI tables
- `ai_usage_daily` — query limits per org
- `forecast_calibration` — accuracy and bias factors
- `scheduling_recommendations` — weekly optimisation results

---

## 7. Cron Jobs (Vercel)

```json
{
  "crons": [
    { "path": "/api/cron/master-sync", "schedule": "0 5 * * *" },
    { "path": "/api/cron/anomaly-check", "schedule": "30 5 * * *" },
    { "path": "/api/cron/health-check", "schedule": "0 6 * * *" },
    { "path": "/api/cron/weekly-digest", "schedule": "0 6 * * 1" },
    { "path": "/api/cron/forecast-calibration", "schedule": "0 4 1 * *" },
    { "path": "/api/cron/supplier-price-creep", "schedule": "0 5 1 * *" },
    { "path": "/api/cron/scheduling-optimization", "schedule": "0 7 * * 1" }
  ]
}
```

---

## 8. Environment Variables (.env.local)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://llzmixkrysduztsvmfzi.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# AI
ANTHROPIC_API_KEY=sk-ant-api03-...

# Email
RESEND_API_KEY=re_...

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...

# Security
CRON_SECRET=your-cron-secret-here
ADMIN_SECRET=your-admin-secret-here

# URLs
NEXT_PUBLIC_APP_URL=https://comandcenter.se
```

---

## 9. Development Commands

```powershell
# Start dev server
npm run dev

# Build for production
npm run build

# Deploy to Vercel
vercel --prod

# Run TypeScript check
npx tsc --noEmit

# Check Supabase connection
curl "https://llzmixkrysduztsvmfzi.supabase.co/rest/v1/" -H "apikey: $env:NEXT_PUBLIC_SUPABASE_ANON_KEY"

# Test cron endpoint
curl -X POST "http://localhost:3000/api/cron/anomaly-check" -H "Authorization: Bearer your-cron-secret"
```

---

## 10. Testing Checklist

### Before deploying
- [ ] All TypeScript errors resolved or `// @ts-nocheck` added
- [ ] Swedish characters display correctly (no `Ã¥`, `Ã¶`)
- [ ] Sidebar business switcher works on all pages
- [ ] Multi-tenant isolation works (org A cannot see org B data)
- [ ] AI query limits enforced (429 response after daily limit)
- [ ] Cron jobs return 200 OK with Bearer token

### After deploying
- [ ] Master sync runs at 06:00 UTC
- [ ] Anomaly detection runs at 06:30 UTC
- [ ] Weekly digest runs Monday 07:00 Stockholm time
- [ ] Forecast calibration runs 1st of month 04:00 UTC
- [ ] Scheduling optimisation runs Monday 07:00 UTC

---

## 10b. Supabase query footguns — MUST avoid

These two patterns have caused production outages. Every new query must follow them.

### `.gte().lte()` on a `date` column — historical bug, no longer reproduces

> **Status update 2026-04-28:** the bug does NOT reproduce against current Supabase. Verified via `scripts/diag-gte-lte-bug.mjs` — all three query patterns (`.gte().lte()` chain, `.gte()` + JS filter, `and(...)` group) return identical row counts including rows on the top boundary. Either Supabase fixed it server-side, or the original 2026-04-18 incident had a different root cause that was misdiagnosed. **The workaround in `lib/sync/aggregate.ts` and `/api/metrics/daily` is now defensive belt-and-braces, not a hard rule.**
>
> Re-run the script before any future cleanup that drops the workaround:
> ```
> node scripts/diag-gte-lte-bug.mjs
> ```
> If it ever reports a mismatch again, the rule comes back in full force.

Original incident notes (kept for context — symptom was real even if cause is now uncertain):

Supabase/PostgREST appeared to silently drop top-boundary rows when both `.gte()` and `.lte()` were chained on a column of type `date`. Apr 17 rows existed in the DB and SQL editor saw them, but the JS-client range chain returned exactly 6 fewer rows. An `.eq()` on the same date worked fine. As of 2026-04-28 we cannot reproduce.

**Old bad pattern (no longer demonstrably broken, but defensive code in some routes still avoids it):**
```ts
db.from('revenue_logs').gte('revenue_date', from).lte('revenue_date', to)
```

**Good:**
```ts
const { data } = await db.from('revenue_logs').gte('revenue_date', from)
const rows = (data ?? []).filter(r => r.revenue_date <= to)
```

Applies to `revenue_date`, `shift_date`, `date`, `period_date` and any other `date`-type column. It does NOT (currently) bite on `timestamptz` columns like `created_at`. See `FIXES.md §0` for the 2026-04-18 incident.

### Always set `cache: 'no-store'` on live-data `fetch()` calls

Client-side `fetch()` responses are cached by the browser. `Ctrl+F5` reloads the HTML but does not reliably evict the fetch cache. Any API call that must reflect current DB state needs:

```ts
fetch('/api/metrics/daily?…', { cache: 'no-store' })
```

And the API route must also set the `Cache-Control` header:

```ts
return NextResponse.json(data, {
  headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
})
```

Both layers required — belt and braces against CDN / reverse-proxy / future browser quirks. See `FIXES.md §0a` for the 2026-04-18 dashboard-staleness incident.

Applies to: `/api/metrics/*`, `/api/tracker`, `/api/forecast`, `/api/budgets`, `/api/departments`, `/api/staff`, `/api/revenue-detail`, `/api/scheduling*`, and any future live-data endpoint.

---

## 10c. AI scope — business-wide vs department-level

Some data lives at the **business** level (Fortnox P&L, whole-business PK totals) and some lives at the **department** level (POS providers tagged per-dept, staff assigned to a department). AI answers must never attribute business-wide numbers to a single department — the figures do not support that split and the owner will act on the answer.

**Rule:** every AI prompt that could see both scopes must include the shared `SCOPE_NOTE` from `lib/ai/scope.ts` in its system prompt or prompt preamble.

```typescript
import { SCOPE_NOTE } from '@/lib/ai/scope'

const SYSTEM_PROMPT = `You are ... ${SCOPE_NOTE}`
```

Business-wide (from `SCOPE_NOTE`):
- `tracker_data` fields: `revenue` (Fortnox), `food_cost`, `staff_cost`, `other_cost`, `depreciation`, `financial`, `net_profit`, `margin_pct`
- every row in `tracker_line_items`
- `monthly_metrics`, `daily_metrics` aggregates

Department-level:
- department-tagged revenue from POS (`pk_bella`, `pk_carne`, …)
- `staff_logs` rows assigned to a dept
- `/api/departments` aggregates

Department margin is `dept_revenue − dept_staff_cost`. It does NOT include food_cost or overheads (those only exist at the business level). When writing AI surfaces, if a question needs a business-wide number to answer a department-scoped question, the AI must say so explicitly instead of pretending.

**Business-wide data IS encouraged for predictive modelling at the business scope** — forecasts, budgets, seasonality, cost-trend analysis, benchmarking against industry norms. Fortnox history is the richest signal we have for whole-business prediction; lean into it. The ban is on misattributing business-wide figures to a specific department, not on using them where they genuinely apply.

Predictive endpoints that now carry `SCOPE_NOTE`:  `/api/ask`, `/api/budgets/generate`, `/api/budgets/analyse`, `/api/budgets/coach`, `/api/tracker/narrative`, `lib/agents/cost-intelligence.ts`. Any new predictive or generative AI surface must do the same.

---

## 11. AI Model Routing — always follow this

Never hardcode model strings. Always import from `lib/ai/models.ts`.

```typescript
// lib/ai/models.ts
export const AI_MODELS = {
  AGENT:     'claude-haiku-4-5-20251001', // Background agents — 70% cheaper
  ANALYSIS:  'claude-sonnet-4-6',          // Complex multi-step reasoning
  ASSISTANT: 'claude-sonnet-4-6',          // Interactive AI assistant
} as const

export const MAX_TOKENS = {
  AGENT_EXPLANATION: 150,
  AGENT_SUMMARY:     300,
  AGENT_RECOMMENDATION: 400,
  ASSISTANT: 2000,
} as const
```

| Use case | Model | Max tokens |
|----------|-------|-----------|
| Anomaly explanation (1 sentence) | Haiku 4.5 | 150 |
| Monday briefing (1 paragraph) | Haiku 4.5 | 300 |
| Onboarding welcome email | Haiku 4.5 | 300 |
| Supplier / scheduling alerts | Haiku 4.5 | 400 |
| Scheduling optimisation (complex) | Sonnet 4.6 | 600 |
| Interactive AI assistant | Sonnet 4.6 | 2000 |

**Cost comparison** (per 1,000 agent calls, avg 500 input + 150 output tokens):
- Haiku 4.5: ~$1.25 total
- Sonnet 4.6: ~$3.75 total
- Saving: 67% per agent run

At 50 customers, all agents running: ~$15/month with Haiku vs ~$45/month with Sonnet.

---

*Read at the start of every session. Companion files: ROADMAP.md · FIXES.md · MIGRATIONS.md*
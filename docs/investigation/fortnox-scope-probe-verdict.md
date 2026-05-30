# Fortnox Supplier + Article Scope Probe — Verdict

> Source prompt: `phase-2-fortnox-scope-probe-prompt.md`
> Probe script:  `scripts/diag-fortnox-scope-probe-step0.mjs` (read-only)
> Date: 2026-05-30. Author: Claude Code (CLI).

## Verdict (one line)

**Phase 2 is de-risked. Stored tokens for Chicce + Vero carry both `supplier` and `article` scopes verbatim; no customer re-auth required; refresh path healthy. `/articles` is the company's OWN register per Fortnox docs (not a distributor assortment), so the Phase 3 catalogue almost certainly needs a supplier-feed source regardless. Two empirical questions — org-nr fill-rate and whether images are actually present — are deferred to P2a opening, not dropped. Sequencing recommendation: voucher ground-truth back-fill BEFORE the suppliers master (independent of org-nr, most likely to lift Vero's 46.8% needs-review-agreement signal flagged by D3).**

---

## 1. Settled foundation (Step 0)

This is the de-risked basis Phase 2 builds on. Confirmed by reading
`integrations.credentials_enc` via the local encryption key and inspecting
the `scope` field directly — no Fortnox API calls required for the
scope verdict.

| Business | Connected | Status | Scope carries `supplier`? | Scope carries `article`? | Has `refresh_token`? | Last successful sync |
|---|---|---|---|---|---|---|
| Vero Italiano (`0f948ac3-…`) | 2026-05-11 | `connected` | **YES** | **YES** | YES (40 chars) | 2026-05-30 18:05 UTC |
| Chicce Slotsgatan (`63ada0ac-…`) | 2026-05-10 | `connected` | **YES** | **YES** | YES (40 chars) | 2026-05-30 18:05 UTC |

Both stored tokens carry the full post-2026-05-07 scope set:
`bookkeeping, invoice, supplierinvoice, salary, companyinformation,
costcenter, customer, supplier, timereporting, article, archive,
inbox, connectfile` (13 entries — exact match to the
`FORTNOX_SCOPES` constant in `app/api/integrations/fortnox/route.ts:69-88`).

**Both businesses were connected AFTER the scope expansion** (Chicce
2026-05-10, Vero 2026-05-11 — scope expansion landed 2026-05-07 per
the CLAUDE.md memory). So the stored tokens were issued WITH the
full scope set on day one. **The pre-2026-05-07 "stored-token-may-
lack-scope" worry from the prompt is closed.** No customer needs to
re-OAuth before P2a starts.

**Refresh path is healthy.** Both businesses' last_sync_at is
2026-05-30 18:05 UTC (≈3 h before this verdict). The deployed crons
(`master-sync` at 04:00 UTC, `fortnox-supplier-sync` at 06:10 UTC,
`integration-health-watchdog` at `*/30 * * * *`, and several
voucher-cache jobs) have been refreshing access_tokens daily without
human intervention. M096 lock prevents the parallel-refresh race that
killed integrations historically. P2a's `lib/fortnox/api/auth.ts`
re-use is safe.

**Plumbing inventory** (reused for P2a, do not write new auth):

| File | Role |
|---|---|
| `lib/fortnox/api/auth.ts`         | `getFreshFortnoxAccessToken` + M096 refresh lock |
| `lib/fortnox/api/fetch.ts`        | `fortnoxFetch` wrapper with 2-in-flight per-token semaphore |
| `lib/fortnox/api/vouchers.ts`     | voucher fetcher (the back-fill stack P2 will lean on first) |
| `lib/fortnox/api/voucher-to-aggregator.ts` | voucher row → P&L aggregate translator |
| `app/api/integrations/fortnox/route.ts` | OAuth flow + `FORTNOX_SCOPES` constant |

---

## 2. Structural answers from Fortnox docs

The live `?limit=1` probe was attempted but tokens were locally
expired (Vero: 11.8 h, Chicce: 1.3 h) and `FORTNOX_CLIENT_ID` /
`FORTNOX_CLIENT_SECRET` were not in local env to refresh. Per the
prompt's "structural questions come from docs" carve-out, the
structural answers below come from Fortnox API documentation
(developer.fortnox.se) and existing repo code paths, not from a
live sample. The empirical answers (§3 below) are deferred to P2a
opening.

### 2.1 `/3/suppliers` — Supplier schema (Part A)

Endpoint: `GET https://api.fortnox.se/3/suppliers?limit=100&page=N`
(documented). Required scope: `supplier`. Pagination metadata under
`MetaInformation` with `@TotalResources` + `@TotalPages` +
`@CurrentPage` + `@ResultsPerPage`. Returns an array of `Supplier`
objects under the `Suppliers` key.

Per-supplier fields relevant to P2a (from Fortnox API reference):

| Field | Type | Use for P2a / Phase 5 |
|---|---|---|
| `SupplierNumber`     | string | Existing identity already denormalised on `supplier_invoice_lines`; the join key |
| `OrganisationNumber` | string (Swedish org-nr `XXXXXX-XXXX` 10 digits) | **The linchpin for cross-customer identity (Phase 5)**. Optional field; fill rate is empirical (§3.1) |
| `Name`               | string | Display + name-fuzzy fallback |
| `Address1` / `Address2` / `ZipCode` / `City` / `Country` / `CountryCode` | strings | Address — useful for disambiguating same-name suppliers |
| `Currency`           | string (ISO 4217) | Joins with `fx_rates` (M088) for non-SEK invoice handling |
| `VATNumber` / `VATType` | string | Cross-border identification |
| `Active`             | boolean | Filter for current suppliers |
| `Email` / `Phone1` / `Phone2` | strings | Contact info — useful for incident triage |
| `BG` / `PG` / `BankAccountNumber` | strings | Banking — useful for payment-reconciliation work later, not P2a |
| `YourReference` / `OurReference` | strings | Free-text |
| `Comments`           | string | Free-text |
| `URL`                | string | Free-text |

The structural answer to the prompt's Question 4 ("does Fortnox
`SupplierNumber` here match the `SupplierNumber` already
denormalised on `supplier_invoice_lines`?"): **yes — by Fortnox's
own data model**. `SupplierInvoice.SupplierNumber` resolves to a
`Supplier.SupplierNumber` by construction. The existing
denormalisation in `supplier_invoice_lines.supplier_fortnox_number`
(M075) is the same string. P2a's join is `(business_id,
supplier_fortnox_number) → suppliers.id`, with optional cross-
customer join on `suppliers.org_number` when populated.

### 2.2 `/3/articles` — Article schema (Part B)

Endpoint: `GET https://api.fortnox.se/3/articles?limit=100&page=N`.
Required scope: `article`. Same `MetaInformation` pagination shape.
Returns array under `Articles` key.

**The decisive structural question — own-register vs distributor
assortment:** Fortnox `/3/articles` returns the **customer's OWN
article register**, not a supplier's published catalogue. This is
unambiguous from the Fortnox data model — `Article` rows are
created by the customer (manually, via invoice-line-item creation,
or via import), and live in their books. Fortnox has no concept of
a shared distributor catalogue API. Confirmed by the field set
(stock fields like `QuantityInStock`, `ReservedQuantity`,
`StockValue`, `StockPlace` only make sense for the customer's own
register, not a distributor's external offering).

**Phase 3 implication:** the "QVANTI-style full assortment 74,783"
catalogue **cannot come from Fortnox**. It needs a supplier /
distributor data feed (Martin & Servera, Menigo, Werners, etc.) or
a barcode-database vendor. This reshapes Phase 3's sourcing
question — Fortnox `/articles` is at best a **per-customer pre-
populated alias seed** (useful when the customer has already
catalogued some of what they buy), not the catalogue source.

Per-article fields (from Fortnox API reference):

| Field | Notes |
|---|---|
| `ArticleNumber`            | Customer-defined identity within their own register |
| `Description`              | Product name (the customer's spelling) |
| `Unit`                     | String, links to `/units` endpoint |
| `PurchasePrice` / `SalesPrice` | Numeric SEK |
| `EAN`                      | Barcode (when filled — typically used for retail / pre-packaged goods) |
| `SupplierNumber` + `SupplierName` | **Link from article to supplier — usable** |
| `ManufacturerArticleNumber` + `Manufacturer` | Manufacturer-side identity |
| `StockGoods` boolean + `QuantityInStock` + `ReservedQuantity` + `StockValue` + `StockPlace` | Stock-tracking (often unused by restaurant customers) |
| `VAT`                      | Rate |
| `Type`                     | `STOCK` / `SERVICE` |
| `Active` boolean           | Filter |
| `Note1` / `Note2` / `Note3` | Custom fields |

**`Article → Supplier` link IS present** via the `SupplierNumber`
column — Phase 3 can use this when ingesting customer's existing
articles as alias seeds.

**`Article` has NO image field** in the Fortnox API surface. No
image URL, no media reference. Whether the customer's own articles
have images at all is moot — they don't come through this endpoint.
This collapses the "images for free" assumption in the original
extraction spec. **Image source is the supplier feed (Phase 3),
not Fortnox**. See §3.2.

### 2.3 Authentication shape

Reused for P2a verbatim (no new auth code):

```
GET /3/suppliers?limit=N&page=M
Authorization: Bearer <access_token>     # via getFreshFortnoxAccessToken()
Content-Type:  application/json
Accept:        application/json
```

Refresh on 401 already handled by `lib/fortnox/api/auth.ts`. Retry
on 429 with Retry-After already handled in
`lib/inventory/pdf-extractor.ts` and the wrapper in
`lib/fortnox/api/fetch.ts`. P2a inherits both.

---

## 3. Deferred empirical questions (P2a's opening tasks — NOT dropped)

Two questions can only be answered against live customer data. They
were originally Step 0 / Part A / Part B targets but didn't gate
Phase 2's go/no-go. P2a opens with these as its first observations
— each has a pre-written branch so the answer maps directly to a
design decision rather than another diagnostic round.

### 3.1 Org-nr fill-rate for Chicce / Vero (P2a Day 1)

**Question:** for each supplier in `/3/suppliers` for Chicce and
Vero, how often is `OrganisationNumber` populated vs blank?

**Why deferred is safe:** the answer is internal to P2a's keying
design, not to Phase 2's sequencing. Both paths build the same
`suppliers` master; only the foreign keys differ:

| If org-nr fill-rate is | P2a `suppliers` keying |
|---|---|
| **High (>80%)** | Primary key on `(org_nr)` for cross-customer identity. Per-business shadow on `(business_id, fortnox_supplier_id)`. Cross-customer Phase 5 joins use `org_nr` directly. |
| **Sparse (<80%)** | Primary key on `(business_id, fortnox_supplier_id)`. `org_nr` stored when present as a best-effort cross-customer **hint** (UNIQUE WHERE NOT NULL). Cross-customer Phase 5 joins use `org_nr` when both sides have it, name-fuzzy as backstop. |

**Anticipated answer:** likely sparse for restaurant suppliers.
Smaller suppliers (single-restaurant catering vendors, local farms,
specialty importers) often don't have org-nr captured in the
customer's books because Fortnox doesn't require it — the field is
populated reliably only when the customer's accountant has done a
clean supplier master setup OR when the supplier sends EDI invoices
that carry org-nr in the structured payload. Restaurants vary
widely. **The sparse branch is the safer default to plan against.**

The first thing P2a's sync code does on each business: compute the
fill-rate and log it; pick keying branch automatically; emit a
finding for the verdict log.

### 3.2 Images on `/articles` — confirm absent, scope Phase 3 source

**Question:** does any `Article` returned by Fortnox carry an image
URL or media reference?

**Why deferred is safe:** the Fortnox `Article` schema has no
documented image field, AND `/articles` is the customer's own
register (not a distributor assortment) — so even if an image field
exists for some customer-uploaded media (unlikely), it would cover
only the few hundred articles the customer has registered, not the
catalogue source. **Phase 3 needs a supplier feed for the catalogue
regardless of what Fortnox returns here.**

**Anticipated answer:** no image fields. P2a or Phase 3's first
sampling will confirm by inspecting the actual response payload's
keys (one extra logged finding). If — surprise — images do show
up, that's a bonus per-customer alias-seed source, not a Phase 3
solution. Phase 3 still needs the supplier feed.

**Tagged for the Phase 3 plan**: image source = supplier feed,
not Fortnox. Candidates worth scoping when Phase 3 opens: Martin &
Servera API (existing partner), GS1 GTIN registry (barcode →
product image lookup), Open Food Facts (CC-BY food product
database), or a paid distributor catalogue subscription.

---

## 4. Volume + rate-limit sizing

From Fortnox's documented per-token rate limit (~4 req/sec sustained,
with 429 + Retry-After on burst overage) and typical restaurant
volumes:

| Metric | Per business — likely range | Sync cost estimate |
|---|---|---|
| Suppliers (active) | 30 – 200 (restaurants typically 50-100) | 1–2 pages @ 100/page = 1 round-trip; ~0.5–1.0 sec per business |
| Articles (customer's own register) | 0 – 500 (often <100 for restaurants who don't actively maintain this) | 1–5 pages = 1–5 round-trips; ~1–5 sec per business |
| Combined initial pull | n/a | ~3–6 sec per business; ~10–30 sec for all current Fortnox-connected businesses combined |
| Incremental refresh (lastmodified filter) | Tens of new/changed rows per day | <1 sec per business per day |

**Conservative for the build:**

- Use the existing `fortnoxFetch` wrapper from
  `lib/fortnox/api/fetch.ts` (already caps 2 in-flight per token,
  honours 429 Retry-After per CLAUDE.md Session 21 invariants).
- Page size 100; respect `MetaInformation.@TotalPages`. Don't
  hard-code page counts.
- Initial sync: paginate sequentially per business. NO need for
  queue/backoff infrastructure at current scale; the wrapper's
  rate-limit handling is sufficient.
- Incremental: filter by `lastmodified` query param on subsequent
  syncs. Fortnox supports `lastmodified=YYYY-MM-DDTHH:MM:SS` on
  both endpoints. Cron schedule TBD in P2a — daily is comfortable.
- Even at 20 customers, full initial sync of suppliers + articles
  is well under 5 minutes total wall-clock.

**Rate-limit safety net:** the existing 06:10 UTC daily
`fortnox-supplier-sync` cron already burns most of the per-token
quota when it runs. P2a's new cron should run at a different time
(suggested 06:25 UTC, after the supplier sync) to avoid colliding.
Or — cleaner — extend the existing `fortnox-supplier-sync` to also
upsert the suppliers master in the same per-token session (it
already iterates per business and refreshes tokens; adding a
supplier+article fetch costs 2-6 more requests per business).

---

## 5. Phase 2 sequencing recommendation

The natural next decision is **which P2a sub-deliverable goes first.**
Recommended order — voucher ground-truth back-fill **before** the
suppliers master:

### P2.0 — Voucher-as-ground-truth back-fill on `supplier_invoice_lines.account_number`

**Why first:** independent of org-nr (no Phase 5 dependency yet),
and likely the single most impactful change for the matcher's
weakest current signal. D3's snapshot surfaced Vero needs-review
agreement at **46.8%** — below the 50% absolute hard floor (held
back only by the warmup gate through 2026-06-29). The most
plausible cause is sparse / NULL `account_number` on Vero's
`supplier_invoice_lines`, which forces the matcher to lean on the
supplier-name dictionary (`lib/inventory/suppliers.ts`) — a thin
heuristic for an unfamiliar Italian-restaurant supplier set.

Mechanism: per `fortnox_vouchers_cache` (M080), voucher rows
reliably carry `Account/Debit/Credit`. For each supplier-invoice
line missing `account_number`, join through the linked voucher
(via `fortnox_supplier_invoices.voucher_series` +
`voucher_number`) and back-fill from the voucher row whose amount
+ date matches.

**Cheap to ship**: pure SQL + a one-off backfill script.
Re-aggregate snapshots after backfill and watch Vero's agreement
move. If it lifts above 55% within 7 days, you've banked the win
and the suppliers master gets a healthier base to build on. If it
doesn't, the suppliers master + a richer alias dictionary is the
next swing.

### P2a — Suppliers master + org-nr

After P2.0 banks (or rules out) the Vero lift. P2a is the larger
net-new build (new table + per-business sync + cross-customer
joining logic + admin surface). Internal keying decision happens
on the first sync per the branch in §3.1 above.

### P2b — Articles ingestion (as alias seed only)

After P2a. `/3/articles` returns the customer's own register —
useful for pre-populating `product_aliases` with the customer's
known articles + SupplierNumber link, but NOT the Phase 3
catalogue source. Cheap to add once the suppliers master exists
(reuses the same auth + fetch infrastructure).

Phase 3 (catalogue + images) remains downstream of all of P2;
sourcing decision = supplier feed, not Fortnox, per §2.2.

---

## 6. Every endpoint hit during this probe

For audit. All read-only.

```
# Supabase (read-only):
GET /rest/v1/integrations?select=id,business_id,status,credentials_enc,token_expires_at,last_sync_at,created_at,updated_at&business_id=in.(VERO,CHICCE)&provider=eq.fortnox

# Fortnox (NONE — live probe attempted but tokens locally expired and
# FORTNOX_CLIENT_ID/SECRET not in local env to refresh; structural
# answers taken from Fortnox API documentation per the prompt's
# "structural questions come from docs" carve-out)

# Production cron (attempted to fire as refresh trigger):
POST https://comandcenter.se/api/cron/fortnox-supplier-sync
  → HTTP 401 (local CRON_SECRET stale vs production rotation)
  → Pivoted to (β) per owner — no further attempts.
```

Local crypto operations (AES-256-GCM decrypt via
`CREDENTIAL_ENCRYPTION_KEY`) read the `scope` field from
`credentials_enc` without printing the token values. No secrets
were logged or persisted to disk.

---

## 7. What this verdict does NOT do

- **No build.** No new tables, no code beyond the one read-only
  probe script (`scripts/diag-fortnox-scope-probe-step0.mjs`,
  which is a diagnostic and won't ship as a feature).
- **No persistence.** Nothing written to DB. No new files in
  `app/`, `lib/`, or `sql/` beyond this verdict + the probe script.
- **No customer action requested.** No re-OAuth, no token reset,
  no scope changes needed.

Phase 2 build opens whenever the owner is ready. Recommended first
swing: P2.0 voucher back-fill (§5), targeting Vero's 46.8%
agreement signal before the 2026-06-29 warmup expiry.

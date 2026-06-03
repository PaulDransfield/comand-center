# Spendrups scraper — scope

**Goal:** lift Vero's thumbnail coverage by ~20 pp (today 18 %, mostly Martin Servera) by capturing the next-biggest supplier — Spendrups (beer / wine / spirits distributor, the dominant alcohol vendor at both Chicce and Vero).

## Why Spendrups next

Per today's coverage diag (`docs/investigation/auto-merge-orphans-v2-dry.txt` context):

| Supplier             | Approx. invoice-line share (Vero alcohol) |
|----------------------|------------------------------------------:|
| Spendrups Bryggeri   | dominant — wines, spirits, beer           |
| Martin Servera       | already scraped (725 articles)            |
| Carlsberg Sverige    | medium — mostly beer                      |
| RIMA Seafood / Marini| food, not relevant for alcohol category   |

Article numbers seen in `supplier_invoice_lines` for Spendrups are 7-digit codes like `2545114` (Antica Osteria Rosso 75cl), `2531814` (Pagus Bisano), `2552614` (Nipozzano Riserva Chianti). Distinct namespace from MS (which uses 6-digit codes like `262899`).

## Investigation findings (live probes)

| Domain                       | Status | Notes |
|------------------------------|--------|-------|
| `www.spendrups.se`           | Public consumer site | Brand-focused, search page (`/hitta-dryck/`) but renders results in JS. Initial HTML shows 0 results until JS hydrates. No article numbers visible in static HTML. |
| `www.spendrups.se/artikel/{id}` | 200 but generic | Returns a 200 OK with 18 KB HTML for any path including bogus IDs — not a real product endpoint. Likely 404-styled-as-200 SPA fallback. |
| `ehandel.spendrups.se`        | B2B portal | Login wall (`/login`). "Bli e-handelskund" registration flow. No anonymous browsing. **This is where the real B2B catalogue lives.** |
| `sortimentet.spendrups.se` / `b2b.spendrups.se` | DNS not found | These don't exist. |

**Conclusion:** unlike Martin Servera (which has truly public product pages with the supplier article number visible to anonymous users), Spendrups gates their B2B catalogue behind a customer login.

## Three approaches, ranked

### Approach A — Systembolaget-fallback (RECOMMENDED if owner OK)

**Idea:** Spendrups distributes many SKUs that are also listed in Systembolaget (the state alcohol monopoly). Systembolaget has a **public, free, official open catalogue** (`api.systembolaget.se`) with product images + names + EAN/GTIN.

**Coverage estimate:** ~60-80 % of Spendrups alcohol SKUs are also in Systembolaget. Spendrups article numbers don't map directly, but EAN/GTIN does — and Spendrups invoices sometimes carry the EAN in the article field or description.

**Effort: ~6 h focused.**
- 2 h: explore systembolaget.se public API + map response shape to `supplier_articles` columns
- 2 h: build `scripts/diag/scrape-systembolaget.mjs` that walks Spendrups invoice lines, extracts EAN, looks up Systembolaget catalogue, writes `supplier_articles` rows
- 1 h: image-cache + transformation URL pipeline (reuse from MS scraper)
- 1 h: handle Spendrups article numbers without EAN (fuzzy name match against Systembolaget, lower confidence)

**Pros:**
- Public, official, well-documented API (no scraping fragility)
- One source serves Spendrups + Carlsberg + Bryggerier i Sverige + most other beverage suppliers — single build, multi-supplier coverage
- No login / session expiry
- Image quality is consistent (Systembolaget has professional product photos)

**Cons:**
- Only covers alcohol (Spendrups also sells some soft drinks)
- Coverage tied to whether the SKU is listed at Systembolaget — restaurant-only specialty wines may not be

### Approach B — Spendrups consumer-search JS scrape

**Idea:** Render `www.spendrups.se/hitta-dryck/` with Playwright (handles the JS hydration), iterate categories (beer / wine / spirits), follow product detail links, harvest article numbers + images.

**Coverage estimate:** unknown — consumer-facing search may not surface the full B2B catalogue. Probably 30-50 % of what Vero actually buys.

**Effort: ~5 h focused.**
- 1 h: probe the live consumer search with Playwright to confirm article numbers ARE visible on detail pages (RISK: may not be — the consumer site might use Systembolaget IDs not Spendrups B2B IDs)
- 3 h: build scraper mirroring `scrape-martinservera.mjs`
- 1 h: integration with `supplier_articles` table

**Pros:** No auth, lowest dependency.  
**Cons:** Coverage gap uncertain; consumer-site article IDs may not match invoice article IDs (high RISK of zero coverage).

### Approach C — B2B portal session-scrape

**Idea:** Owner logs into `ehandel.spendrups.se` once, exports Playwright `storageState`, scraper reuses session to walk the full B2B catalogue.

**Coverage estimate:** ~95 % (full Spendrups catalogue available to logged-in customers).

**Effort: ~10-12 h focused + ongoing.**
- 2 h: build session-export tooling (owner-side `node scripts/diag/spendrups-auth-export.mjs`)
- 4 h: explore B2B portal structure, identify category URLs, product detail page shape, pagination
- 4 h: build scraper with session reuse
- Ongoing: session expires (usually 30-90 days), owner must re-export periodically — 5 min/quarter

**Pros:** Best coverage, real B2B article numbers matching invoices.  
**Cons:** Auth maintenance burden; tied to Vero's customer account (any future Spendrups customer at a different restaurant gets the same images but no fresh data — same as MS today which is a feature not a bug); risk of ToS issues with B2B scraping.

## Recommendation

**REVISED 2026-06-03** after Q1 diag (`scripts/diag/diag-spendrups-articles.mjs`):

| Article-number shape | Count | Example |
|---|---:|---|
| 7-digit Spendrups internal code | 130/200 (65 %) | `2512514` "TENUTA FRESCOB DI CASTIGL 75EG" |
| Non-product overhead (pallets / deposits / gas) | 70/200 (35 %) | `39510` "EUR-PALL GODKÄND", `39733` "BIOGON NC50" |
| EAN/GTIN in article_number field | 0/200 | — |
| EAN/GTIN in raw_description | 0/200 | — |

**Spendrups doesn't emit EANs on invoices.** The 7-digit codes are Spendrups-internal SKUs that don't map to any public identifier.

This downgrades Approach A from "60-80 % coverage via EAN bridge" to **name-match-only** against the Systembolaget catalogue — lower confidence (Jaccard on "TENUTA FRESCOB DI CASTIGL 75EG" vs Systembolaget's full name "Tenuta Frescobaldi Castiglioni 75cl"). Still useful but no longer the obvious winner.

**New recommended sequence:**

1. **First — Approach B (Spendrups consumer JS scrape)** with a quick probe to see if Spendrups' own consumer search (`/hitta-dryck/`) exposes the same 7-digit codes used on invoices. If yes → MS-style scraper, 5 h, **100 % match by code**. If no → drop B entirely.
2. **Second — Approach A as name-match fallback** for everything B doesn't cover (Jaccard ≥ 0.6 against Systembolaget, owner-review queue for uncertain matches). ~3 h on top of B.
3. **Long tail — Approach C (B2B session scrape)** only if A+B coverage < 60 %.

Net effort if B works: **5-8 h**. If B fails entirely: **~9-15 h with C**.

Approach C is parked behind B/A; revisit after measuring.

## Open questions before build

1. **Spendrups invoice line `article_number` format**: is it consistently the 7-digit Spendrups code, or do some lines carry the EAN/GTIN instead? Quick query against `supplier_invoice_lines` to find out — informs whether we can match Systembolaget by article_number alone or need EAN-from-description fallback.
2. **Is the Systembolaget API rate-limited?** Their docs claim "no harsh limits" but a 5000-product walk would be ~5000 requests. Worth chunking + delay.
3. **Storage bucket policy**: same `supplier-article-images/` bucket as MS? Or split per supplier? Recommend same bucket — keeps the batch endpoint logic identical, image_cached_path namespacing handled by the (supplier_fortnox_number, article_number) PK.

## Effort summary

| Approach | Coverage | Effort | Maintenance |
|---|---:|---:|---|
| A — Systembolaget | ~60-80 % | 6 h | None |
| B — Spendrups consumer | 30-50 % | 5 h + investigation risk | Site changes fragile |
| C — B2B session | ~95 % | 10-12 h | Quarterly auth re-export |

**Recommended sequence: A → measure coverage → if gaps matter, layer C on top.**

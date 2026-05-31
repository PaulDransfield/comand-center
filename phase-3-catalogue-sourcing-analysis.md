# CommandCenter — Phase 3 Catalogue Sourcing: Decision Analysis

**Status:** Pre-Phase-3 decision work, written during the Phase D watch — 2026-05-31
**Owner:** Paul Dransfield
**Context:** The scope probe established Fortnox `/articles` is the customer's *own* register, not a distributor's full assortment, and carries no image field. So the "full assortment vs my assortment" catalogue model (the QVANTI-style ingestion that makes mapping *selection* not *creation*, and supplies images + clean names) needs an **external source**. This document works out which, so that *if* Phase D points us at Phase 3, the sourcing question is already answered rather than starting cold.

> **Reframe up front:** "the catalogue" is really **two separable jobs**, and they don't need the same source:
> 1. **The mapping seed** — canonical article identity (code, name, pack size, supplier) so an incoming invoice line resolves by selection. This is the part that lifts match rates and reduces owner effort.
> 2. **Enrichment** — product images + tidy display names + nutrition/allergen, mostly cosmetic-to-useful, not match-critical.
> Conflating them is what makes Phase 3 look like one big sourcing problem. Job 1 is the moat-relevant one; Job 2 is nice-to-have polish that a free source can largely cover.

---

## The options, assessed

### Option 1 — Distributor data (Martin & Servera et al.) via EDI / supplier feed
**What it is:** The wholesalers restaurants actually buy from (Martin & Servera, Menigo, Svensk Cater) hold the real foodservice assortment — the exact articles, codes, pack sizes our customers' invoices reference.
**Finding:** Martin & Servera's integration story is **EDI for transactional exchange** (orders, despatch, invoices between business systems) — not a public product-catalogue API. The catalogue itself sits behind a logged-in, customer-specific account with customer-specific pricing. There's an e-commerce platform and a supplier portal, but no evidence of an open "give me your 75k-article catalogue" endpoint.
**Implication:**
- **Best-fit data** (it's literally the articles on the invoices) but **highest-friction access** — likely needs a commercial/partner conversation per distributor, or EDI onboarding, or a per-customer authenticated pull.
- Pricing is customer-specific, so even with access, prices can't be treated as a shared catalogue — only article *identity* (code/name/pack) is shareable; price stays per-customer (which aligns with our existing governance line).
- **Not a day-one source.** This is a partnership track, not an integration sprint.

### Option 2 — Open Food Facts (OFF)
**What it is:** Free, crowdsourced, barcode(EAN/GTIN)-keyed database — 4M+ products, 150 countries, ODbL data licence, CC-BY-SA images, free API, no key.
**Finding (verified):** Strong for **consumer retail** products by barcode; supplies name, brand, quantity/packaging, category, **images**, nutrition/allergens. But: voluntary contributions, **no accuracy/completeness guarantee**, **no pricing**, and crucially **no pack-size/foodservice catalogue semantics** — a 5kg foodservice sack of flour or a restaurant-pack of San Pellegrino may be absent or thinly covered, where consumer SKUs are well covered.
**Implication:**
- **Excellent, free Job-2 enrichment** (images + names + nutrition) **where the invoice line carries an EAN** that matches a consumer SKU — e.g. bottled drinks, branded packaged goods. This is real, immediate, zero-cost value for a chunk of the assortment.
- **Weak Job-1 seed** for true foodservice articles (distributor-coded bulk items), which often have no consumer barcode at all.
- Licence note: ODbL + CC-BY-SA carry **attribution/share-alike obligations** — usable, but the terms need a deliberate read before shipping (especially share-alike on any derived database).

### Option 3 — GS1 Sweden / GTIN registry (Validoo)
**What it is:** GS1 is the authoritative barcode/GTIN registry; in Sweden, **Validoo** is the GS1 product-data pool many suppliers publish verified master data into (name, pack hierarchy, dimensions, images, often foodservice-grade).
**Finding (from prior knowledge, flagged to verify):** This is the *authoritative* version of what OFF approximates — verified, supplier-published master data including foodservice pack hierarchies. Access is typically **commercial/subscription**, oriented at retailers/distributors.
**Implication:**
- **Authoritative Job-1 seed + Job-2 enrichment** for GTIN-carrying articles, foodservice-aware — much closer to what we actually need than OFF.
- **Paid, and access model needs confirming** (is it open to a SaaS reseller, what tier, what coverage of foodservice vs retail). This is the option most worth a verification call.

### Option 4 — Bootstrap from our own confirmed data (the sleeper)
**What it is:** We already accumulate, per customer, confirmed `product_aliases` linking real invoice descriptions → canonical products, with supplier codes and (post-P2.0) BAS accounts. Across customers, with the Phase-2 supplier master keyed on org-nr, the **supplier-article identity is shareable** (not price).
**Implication:**
- **Zero new external dependency.** Every confirmed alias at one Italian restaurant is a seed for the next one buying from the same distributor. This is the cross-customer alias network (Phase 5) viewed as a catalogue — it *is* a self-built foodservice catalogue, accreting from real usage.
- Slower to start (cold for the first customers) but **compounds**, is fully ours, and is foodservice-accurate by construction (it's literally what customers buy).
- The cross-business overlap figure from the elevated-queue dry-run is the direct evidence of how fast this compounds.

---

## The shape of the recommendation

**Not one source — a layered strategy, sequenced by cost-to-value:**

1. **Job-2 enrichment now, cheap:** wire **Open Food Facts by EAN** for the barcode-carrying slice of the assortment (drinks, branded packaged goods). Free, immediate images + clean names where a barcode matches. Treat as best-effort enrichment, never as match-critical truth. Read the ODbL/CC-BY-SA terms first.
2. **Job-1 seed, self-built, compounding:** lean into **Option 4** — the cross-customer alias network *is* our foodservice catalogue, and it's the moat. Phase 2's supplier master (org-nr) is the prerequisite, which is already on the path. This needs no external deal and is accurate by construction.
3. **Authoritative seed, investigate in parallel:** open a **GS1 Sweden / Validoo** conversation to learn access model, foodservice coverage, and price. This is the option that could materially accelerate Job 1 if the terms work — worth a real inquiry, not a build.
4. **Distributor data, partnership track:** treat **Martin & Servera / Menigo** as a *business-development* conversation, not an integration task — best-fit data, highest friction, and the natural lever once there are enough customers to make us worth their integration time (which rhymes with the "Personalkollen/Novax as capital/partnership precedent" thinking).

**Net:** the catalogue isn't a single ingestion to build — it's OFF enrichment (free, now) + the self-built alias network (the moat, compounding) + two partnership/subscription conversations (GS1, distributors) that don't block code. That reframing means Phase 3 has a cheap, shippable core that doesn't wait on anyone's deal.

---

## What this changes about sequencing

- The earlier "full assortment 74,783" mental model (lift a distributor's whole catalogue) is **not the day-one shape** — that's the partnership track. The day-one shape is *enrich what we can by barcode + grow the seed from confirmed usage.*
- This **strengthens the case for P2a (supplier master, org-nr) regardless of Phase D**, because Option 4 — the compounding self-built catalogue — depends on it. So P2a earns its place from two independent directions now (supplier identity for learning, and as the spine of the catalogue).
- Nothing here is blocked by the Phase D watch; it's analysis and two external inquiries.

## Open questions to resolve before Phase 3 builds

1. **GS1/Validoo access + foodservice coverage + price** — the one worth a real inquiry; could change the whole Job-1 picture.
2. **EAN availability on our invoice lines** — what fraction of `supplier_invoice_lines` actually carry a barcode? (Determines how much of the assortment OFF can even enrich.) A cheap read-only check answers it.
3. **ODbL / CC-BY-SA obligations** — attribution + share-alike read before shipping OFF-derived data.
4. **Distributor BD appetite** — is M&S/Menigo worth approaching now, or at the ~15–20 customer mark (the Norway-expansion threshold rhymes here)?

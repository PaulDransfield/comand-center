# Claude Code — Phase 2 Kickoff: Fortnox Supplier + Article Scope Probe (READ-ONLY)

## Purpose

Settle the biggest remaining unknown before any Phase 2 build: **do the granted Fortnox `supplier` and `article` scopes actually return usable data with the tokens we hold today, and what's in them?** The answer gates three things — the `suppliers` master + org-nr (P2a), the cross-customer identity story (Phase 5), and the full-assortment catalogue + images (Phase 3). This was deferred out of Phase 1 because it needed `FORTNOX_CLIENT_ID` in the diag env.

This is a **read-only probe against a live third-party API.** Characterise the data; sync nothing, store nothing, write nothing.

## HARD RULES

- **GET only against Fortnox.** No `POST/PUT/DELETE` to Fortnox under any circumstance. No DB writes. No migrations. No new persistent tables. A throwaway probe script is fine; it must not persist results anywhere except the verdict doc.
- **Respect Fortnox rate limits.** Fortnox throttles aggressively (historically ~4 req/sec, a few hundred/min). **Sample, do not sync** — fetch the *first page* (~50–100 rows) plus pagination metadata to get totals. Do **not** pull the full catalogue. Run off-peak so you don't collide with the live daily sync's quota.
- **Never print secrets.** No tokens, no `client_secret`, no `credentials_enc` contents. Report token *scope* and *validity*, never the value.
- Probe only businesses with a real Fortnox connection: **Chicce** (established) and **Vero Italiano** (connected ~May 11). **Rosali has no Fortnox — skip it.**
- Deliverable: `docs/investigation/fortnox-scope-probe-verdict.md` + a short chat summary. No build — we scope P2a from the findings.

## Step 0 — Locate the plumbing, confirm the tokens carry the scopes

Before any API call:
- Find the Fortnox client / auth handling (token storage, refresh, the existing `/supplierinvoices` and `/vouchers` call sites). Reuse that client; don't write a new auth path.
- For Chicce and Vero, determine **what scopes the stored tokens actually carry.** Scopes granted at the OAuth *consent screen* don't help if the *stored token* predates them. Critical question: were these businesses connected **before or after** `supplier` + `article` scope was added to the consent request? If before, the token may lack the scope and a **re-auth** is required — that's a finding, not a blocker to discover later.
- Report, per business: token valid? refreshable? carries `supplier`? carries `article`?

## Part A — `/suppliers` probe (gates P2a + Phase 5)

Fetch a sample page of suppliers for each business. Answer:

1. **Is org-nr present and populated?** This is the linchpin — cross-customer supplier identity (Phase 5) joins on org-nr. Confirm the field exists (likely `OrganisationNumber`), and crucially **how often it's actually filled** vs blank across the sample. A field that exists but is 70% empty changes the P2a design.
2. What else comes back per supplier — `SupplierNumber`, `Name`, address, country, currency, VAT number, active flag? List the usable identity fields.
3. **Total supplier count** per business (from pagination metadata, not by pulling all).
4. Does the Fortnox `SupplierNumber` here match the `SupplierNumber` already denormalised on `supplier_invoice_lines`? (Confirms we can join the new master back to existing lines.)

## Part B — `/articles` probe (gates Phase 3 — and likely reshapes it)

Fetch a sample page of articles for each business. Answer:

1. **The decisive question: is `/articles` the customer's OWN article register, or the supplier's full published assortment?** Strong prior: Fortnox `/articles` is the *company's own* registered articles (things they've set up), **not** a distributor's full catalogue. If so, the QVANTI-style "full assortment 74,783" model **cannot come from Fortnox** — it needs a supplier/distributor data feed (Martin & Servera et al.) instead. Confirm which it is; this directly reshapes the Phase 3 catalogue plan.
2. What fields per article — code, name, unit, pack/quantity, purchase price, EAN/barcode, supplier link?
3. **Are there images?** Does the article carry an image URL or any media reference? (This is the "images for free" assumption in the extraction spec — verify it's real, or mark images as still-needing-a-source.)
4. **Total article count** per business (pagination metadata).
5. Is there a usable link **article → supplier** (so an article can be attributed to who sells it)?

## Part C — Volume & sync feasibility

From the counts and rate limits, characterise what a real sync would cost:
- Approx total suppliers + articles per business, and across all Fortnox-connected businesses.
- Given Fortnox's rate limit, roughly how long a full initial pull + incremental refresh would take, and whether it must be paginated/queued/back-off-aware. (Don't build it — just size it, so P2a/P3 are planned realistically.)

## Deliverable — the verdict

Write `docs/investigation/fortnox-scope-probe-verdict.md`:

- **Go / no-go per scope, per business:** can we read suppliers and articles today, or is re-auth needed first?
- **Org-nr verdict:** present? populated how reliably? → feeds the P2a `suppliers` master keying decision.
- **Articles verdict:** own-register vs full-assortment — and therefore **where the Phase 3 catalogue actually has to come from** (Fortnox vs a separate supplier feed).
- **Images verdict:** real from Fortnox, or still need a source.
- **Volume + rate-limit sizing** for the eventual sync.
- Every endpoint hit, with counts (no secrets, no full dumps).
- **No build.** Stop at the verdict.

Chat summary, three lines: (1) can we read both scopes today or is re-auth needed; (2) is org-nr reliably populated; (3) is `/articles` own-register or full-assortment — i.e., does the catalogue come from Fortnox or do we need a supplier feed.

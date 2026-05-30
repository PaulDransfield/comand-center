# Claude Code — Rosali / Vero Identical-Data Diagnostic (READ-ONLY)

## Purpose

The VAT diagnostic surfaced something unrelated and possibly more serious: **Rosali Deli's January 2026 `tracker_data` row is byte-identical to Vero Italiano's** (same revenue 1,817,099, dine_in 669,610, takeaway 74,127, alcohol 1,062,068), despite being different businesses — and Rosali has **no Feb–May data at all**. Identical aggregates across two businesses are not coincidence. Find the root cause and the blast radius. **Change nothing.**

## HARD RULES

- **Read-only.** `SELECT` / `COUNT` / `SUM` only. No `INSERT/UPDATE/DELETE/ALTER/DROP`, no code changes, no migrations, no deploys.
- **Print every query** you run. Aggregate or `LIMIT`; don't dump raw rows. **Never print secrets** (`credentials_enc`) — report only whether two rows *match*, not their contents.
- Deliverable: `docs/investigation/rosali-vero-verdict.md` + a one-line chat summary. No fix.

## The first question that determines everything: tenancy boundary

Before anything else, establish whether Vero Italiano and Rosali Deli are **the same org** (intra-org correctness bug — same owner sees one restaurant's data on another) or **different orgs** (cross-tenant leak — far more serious, escalate immediately).

- Look up both `businesses` rows, their `org_id`, and list all businesses under each org.
- State plainly: **same org_id or not.** If different orgs → stop, flag as a potential cross-tenant data exposure, and prioritise that framing in the verdict.

(Per the current-state report, Vero's org appears to contain both Vero Italiano + Rosali Deli — so the expected answer is intra-org. Confirm it; don't assume.)

## Hypotheses to test

1. **Shared Fortnox integration, wrong attribution.** Both businesses may map to one Fortnox company, and the backfill wrote the *same vouchers* to both `business_id`s.
   - Compare `integrations` rows (provider='fortnox') for both businesses: do they reference the **same Fortnox tenant / external company id / token**? (Report match/no-match only — no secret values.)
   - In the voucher / supplier-invoice caches (`fortnox_vouchers_cache` M080, `fortnox_supplier_invoices` M098, `supplier_invoice_lines`), are identical source rows attributed to **both** `business_id`s?

2. **Org-scoped instead of business-scoped write.** The aggregator/rollup grouped by `org_id` and wrote the same aggregate to multiple business rows.
   - Compare `tracker_line_items` for both businesses, Jan 2026: identical `fortnox_account` / `label` / `amount` set? If the *line items* are also identical, the cross-attribution is upstream of the aggregate.

3. **Seed/copy artifact.** Rosali was seeded from Vero during onboarding/testing and never got real data (would explain no Feb–May).
   - Compare `created_at`, `source`, `created_via` on Rosali's vs Vero's Jan `tracker_data` row. Same timestamp/source → copy. Different → independent write of identical data (worse — points at a live scoping bug).

## What to report

- **Tenancy boundary:** same org or not (the headline).
- **Root cause:** which hypothesis the evidence supports, with the queries that show it.
- **Depth:** is the cross-attribution only in the **aggregate** (`tracker_data`), or does the **raw source** (`supplier_invoice_lines` / voucher cache) also carry Vero's data under Rosali's `business_id`? (Aggregate-only is easier to repair; raw-level is deeper.)
- **Does Rosali have ANY genuine data of its own**, ever? Period coverage per business.
- **Blast radius:** which businesses, which periods, which surfaces read the bad rows (dashboard, `/financials`, `/api/tracker`, AI snapshot).
- **Every query run.** No fix — stop at the verdict.

One-line chat summary: same-org-or-not, root cause, and whether raw source data is cross-attributed or only the aggregate.

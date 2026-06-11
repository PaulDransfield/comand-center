# Froda embedded-lending — integration pre-scope

> Companion to `embedded-finance-strategy-memo.md`. This is the **pull-off-the-shelf plan** for when the trigger hits — NOT a now-build. Captured 2026-06-11.
> **Do not build, and do not contact Froda, until ≈15–30 paying Swedish customers** (the memo's trigger). This doc just means there's zero scramble when that day comes.

## 0. One-line shape

"CommandCenter Capital" = a branded loan offer in-app; the customer consents; we hand Froda the **already-computed, Fortnox-verified financial pack**; Froda underwrites, lends, services, and carries the risk + licence; we earn an origination + interest-spread share. Our build is small because the underwriting data already exists — see §3.

## 1. Our role (decides the whole compliance surface)

- **Credit intermediary / distribution partner**, NOT a lender. The Finansinspektionen credit-market licence stays with Froda.
- Sits under **ComandCenter AB** (so AB registration — P0 in `ENTERPRISE-READINESS-CHECKLIST.md` — is a hard dependency).
- Compliance surface that still lands on us: how the offer is marketed + disclosed, possibly first-line KYC/AML, and the data-sharing consent. Confirm the split in the partner agreement (§5).

## 2. Commercial track (the agreement — do this BEFORE any code)

Sharpened from the memo's §9 open questions into negotiable terms to nail down:

- [ ] **Revenue split** — origination fee % (paid on drawdown), interest-spread share %, and how/when it settles (Froda has automatic split settlement — confirm the reporting we receive).
- [ ] **KYC/AML ownership** — who runs first-line KYC/AML, and what's operationally required of us (if any).
- [ ] **Collections / NPL** — confirm Froda owns origination → servicing → non-performing-loan handling (the "no partner risk" claim), in writing.
- [ ] **Brand insulation** — how a borrower's negative experience (default, collections, dispute) is kept off the CommandCenter brand.
- [ ] **Minimum volume / partner floor** — is there an origination or customer-count threshold to onboard? (Validates our trigger.)
- [ ] **Repayment mechanics** — % of daily card sales vs fixed monthly. **Card-sales repayment likely needs Froda's Visa business-card issuance — probably NOT our path; default to the standard Loans product** (fixed/RBF without a card rail).
- [ ] **Data-sharing & consent structure** — exactly what we pass for underwriting, the legal basis, and the GDPR consent flow (§4).
- [ ] **Markets** — Sweden first (home); Norway when expansion lands (Froda live in both).
- [ ] **Contract type** — tied-agent vs referral/introducer arrangement under Froda's licence.

## 3. Technical track — the underwriting data pack (our strongest asset, mostly built)

The whole point: we already compute what a lender needs per business. The integration's core is assembling a **consented "lending pack" export**. Mapping to what exists today:

| Underwriting input | Source in CommandCenter | Status |
|---|---|---|
| Verified monthly revenue (12–24 mo) | `tracker_data` (single-writer, Fortnox-verified) + `monthly_metrics` | ✅ exists |
| P&L / net margin / cost ratios | `tracker_data` + `tracker_line_items` (BAS buckets, `lib/overheads/basBuckets.ts`) | ✅ exists |
| Current cash position | Fortnox 1xxx balances (`lib/fortnox/api/account-balance.ts`, `/api/finance/bank-position`) | ✅ exists |
| Forecast / forward demand | `lib/forecast/*`, `forecasts` | ✅ exists |
| Business identity | `businesses` (org_nr, name, address), Fortnox company identity | ✅ exists |
| Cash-flow projection | `/api/finance/cash-flow-projection` | ✅ exists |

**New build = a single consented export endpoint** that assembles the pack per business into whatever shape Froda's API wants (JSON). Most of the work is mapping + consent, not computation.

### Other technical pieces (when triggered)
- **Offer surface** — a "CommandCenter Capital" page (or dashboard card) shown only to eligible businesses. Eligibility pre-filter computed from our data (e.g. ≥N months verified history, margin not deeply negative, healthy cash trend) so we don't surface offers that will be declined.
- **Application handoff** — customer clicks → explicit consent screen → we POST the lending pack to Froda's embedded API → customer completes Froda's flow → approval/funds. Froda quotes ~2 weeks / 2 devs for their API.
- **Settlement / revenue view** — ingest Froda's split-settlement reporting into a simple ledger so we can see origination + interest-share income per loan. Could ride the existing tracker as a new revenue line.
- **Consent / GDPR plumbing** — Froda becomes a **data recipient** (and we a referrer): explicit per-business consent to share the financial pack, a DPA with Froda, privacy-policy + sub-processor-list update, and a Records-of-Processing entry. Ties into `LEGAL-OBLIGATIONS.md` + the security/DPA work.
- **Auth/role** — owner-only surface (financing = an owner decision). Reuse `requireOwnerRole`.

## 4. Data-readiness check (worth doing even before the trigger — it's free insurance)

The memo's one near-term note: keep the data export-clean. Quick audit to run now or near-trigger:
- [ ] Confirm `tracker_data` has ≥12 months of Fortnox-verified, non-provisional monthly revenue + net margin per active business (mind the known Vero 2025 gap — `project_vero_2025_data_gap`).
- [ ] Confirm current cash position resolves per business via the Fortnox balance path.
- [ ] Confirm a forecast exists per business.
- [ ] Sketch the one JSON "lending pack" shape so the eventual export is a mapping job, not a data hunt.

## 5. Build phases (only when triggered)

| Phase | Scope | Depends on |
|---|---|---|
| **0 — Commercial** | Open Froda conversation (frodaembedded.com), agree §2 terms, sign partner agreement + DPA. | AB registered; ~15–30 customers |
| **1 — Data pack + consent** | Lending-pack export endpoint + GDPR consent flow + sub-processor/RoP/privacy updates. | Phase 0 terms (exact fields) |
| **2 — Offer + handoff** | Eligibility filter, "CommandCenter Capital" surface, Froda API application handoff. | Phase 1 |
| **3 — Revenue tracking** | Ingest Froda settlement → revenue ledger/reporting. | Phase 2 live |

Rough effort once unblocked: small. The data is the hard part and it's done; the rest is an export, a consented handoff (~2 wks/2 devs per Froda), an offer page, and a reporting view.

## 6. Hard dependencies / blockers
1. **~15–30 paying customers** (the trigger — without volume, no partner interest + no material revenue).
2. **ComandCenter AB registered** (can't sign the partner agreement/DPA otherwise).
3. **DPA + sub-processor + consent** plumbing (overlaps the security/legal work already on the checklist).

## 7. What NOT to do now
- Don't build the export, offer surface, or any Froda wiring.
- Don't contact Froda yet.
- DO keep the verified-financials + cash-position data clean (it's the asset) and keep this doc current if the data model shifts.

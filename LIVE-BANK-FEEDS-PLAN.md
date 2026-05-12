# Live bank feeds — build plan

> Drafted 2026-05-12. Brainstormed during the "what next for cash visibility" review. This is a scoping doc, not a commitment.

## Problem

CommandCenter's cash position tile and 30-day projection both source from **Fortnox-booked** bank balances. Booked ≠ live. If the customer's accountant is behind on entering deposits (Vero's situation right now — April + May 2026 deposits not yet booked), our "current cash" number lags real bank reality by days or weeks. We ship a `bookkeeping_lag` warning chip but that's a band-aid; the headline number is still off.

Live bank feeds via PSD2/Open Banking connect us **directly to the customer's bank API**, bypassing the Fortnox lag entirely. Real balance, real transactions, refreshed every few hours.

This is the single biggest upgrade we can make to cash visibility short of becoming an ERP, and it unlocks downstream features (POS-to-bank reconciliation, supplier-invoice-to-bank-debit matching, fraud detection, payment anomaly alerts) that are hard or impossible without it.

## Why this matters strategically

Sits squarely in the Path 1 strategy (deeper intelligence layer, not full ERP). Defensible because:
- Bank data + AI-driven insight is the highest-trust feature a restaurant intelligence platform can offer
- Restaurant365 has this in the US; no European equivalent does it well for SE specifically
- Once a customer connects their bank, our retention story changes — leaving means re-authenticating 5 services elsewhere

## Provider landscape

PSD2 read-only Account Information Service (AIS) is regulated. We do NOT need to be a licensed AISP — we consume the data via a licensed provider that holds the regulatory burden.

| Provider | Coverage | Pricing | Notes |
|---|---|---|---|
| **Nordigen / GoCardless Bank Account Data** | EU, all major SE banks (HB, SEB, Swedbank, Nordea, Danske, SBAB) | **Free** for our use case (~1k calls/day) | EU-headquartered. Limited refresh frequency (~4×/day per account) but plenty for cash visibility. **Recommended for v1.** |
| Tink (Visa-owned, Stockholm) | EU, premium SE coverage, real-time | ~30-50k SEK setup + per-account fees | More polished, faster refresh, better support. Worth considering if Nordigen rate limits bite. |
| Klarna Kosma | EU, strong SE | Pay-as-you-go | Younger, less mature DX than Tink. |
| TrueLayer | UK-first, EU expanding | Per-call pricing | Better for UK; we're SE-first. |

**Recommendation: start with Nordigen.** Free, EU-regulated, sufficient for our use case. If we hit rate limits or need real-time push, migrate to Tink in v2 — the integration code is replaceable since both speak PSD2 patterns.

## Architecture

### Data model

```sql
-- New tables (M???):

bank_connections                  -- one per business per bank
  id, org_id, business_id
  provider                        -- 'nordigen' | 'tink' | ...
  provider_requisition_id         -- their handle on the consent
  institution_id                  -- 'SEB_ESSESESS' etc.
  institution_name                -- 'SEB Sweden'
  status                          -- 'active' | 'expired' | 'revoked' | 'error'
  consent_granted_at, consent_expires_at  -- PSD2 90-day window
  last_synced_at, last_sync_error
  created_by_user_id              -- audit
  created_at, updated_at

bank_accounts                     -- accounts under a connection
  id, connection_id, business_id, org_id
  provider_account_id             -- their handle on this account
  iban
  bic
  account_name                    -- "Företagskonto"
  account_type                    -- 'checking' | 'savings'
  currency                        -- 'SEK'
  current_balance                 -- live, refreshed each sync
  available_balance               -- live, may differ from current
  balance_as_of                   -- when we last got it
  default_for_cash_position       -- bool — operational account
  fortnox_account_link            -- nullable, BAS account number e.g. 1930
  created_at, updated_at

bank_transactions                 -- raw bank-feed transactions
  id, account_id, business_id, org_id
  provider_transaction_id         -- their unique ID
  booking_date, value_date
  amount                          -- signed: positive = inflow
  currency
  description                     -- raw bank narrative
  counterparty_name               -- inferred from narrative or structured field
  counterparty_iban
  reference                       -- OCR / structured reference
  category                        -- our classification: 'pos_settlement' | 'supplier_payment' | 'salary' | 'fskatt' | 'vat' | 'unknown'
  matched_fortnox_voucher_id      -- nullable — link to vouchers when reconciled
  matched_supplier_invoice_id     -- nullable — link to supplier invoice
  matched_pos_zreport_date        -- nullable — link to POS Z-report
  created_at
```

Unique constraints:
- `bank_connections (business_id, provider, institution_id)` — one connection per bank per business
- `bank_accounts (provider_account_id)` — provider's account ID is globally unique
- `bank_transactions (provider_transaction_id)` — provider transactions are unique; idempotent re-fetch

### Sync architecture

- **Initial sync**: on first connection, pull last 90 days of transactions + current balance per account. Nordigen returns this in one call; Tink chunks it.
- **Recurring sync**: cron at 06:00, 11:00, 16:00, 21:00 Stockholm time — 4× daily fits Nordigen's free-tier limits and covers operational hours.
- **On-demand refresh**: dashboard button. Rate-limited per business (max 1/hour) to avoid hitting provider limits.
- **Consent renewal**: 90-day PSD2 window. At day 80, send email + dashboard banner: "Reconnect your bank by [date] to keep cash visibility working." Pattern matches our existing `integrations.needs_reauth` flow for Personalkollen + Fortnox.

### Reuse from existing patterns

- **Encryption**: same AES-256-GCM helper at `lib/integrations/encryption.ts` for storing access tokens
- **OAuth confirmation modal**: same business-selection + tick-to-confirm pattern from the Fortnox flow (memory `feedback_oauth_business_confirmation.md`). Bank OAuth has even higher stakes — wrong business binding would be a real breach.
- **Sync engine**: extend `lib/sync/engine.ts` with a `runBankSync()` path analogous to `runFortnoxSync()`. Or write a new lib at `lib/bank/sync.ts` parallel to it.
- **Audit log**: every bank sync writes a `sync_log` row, same pattern as PK and Fortnox.

## Phases

### Phase A — foundation & first connection (Weeks 1-2)

- Nordigen production account + sandbox setup
- New table migrations (M???-BANK-CONNECTIONS, M???-BANK-ACCOUNTS, M???-BANK-TRANSACTIONS)
- OAuth/PSD2 flow: `/api/integrations/bank/connect` initiates, `/api/integrations/bank/callback` handles return
- Business-selection confirmation modal (reuse `oauthConfirm` from `/integrations`)
- Encrypted token storage
- Basic /integrations row with "Bank" provider entry, connect button, status display
- Connect Vero as the test customer

**Deliverable**: a Vero employee can authenticate via BankID and we have her bank account list in our DB. No data refresh yet.

### Phase B — sync + transaction storage (Weeks 3-4)

- `lib/bank/sync.ts` — initial sync (last 90 days) + recurring sync
- Cron `/api/cron/bank-sync` running 4×/day
- Error handling: consent expired → status='expired' + email; rate limited → backoff; provider 5xx → retry
- Persist transactions with deduplication on `provider_transaction_id`
- Manual "Refresh now" button on /integrations with per-business 1/hour rate limit

**Deliverable**: Vero's bank balance + last 90 days of transactions visible in our DB, refreshing automatically.

### Phase C — cash visibility integration (Weeks 5-6)

- Cash Position tile: switch headline from Fortnox-booked → live bank when available
  - Source toggle: show "Live · updated 2h ago" badge when live data exists
  - Drop the bookkeeping-lag chip when live source is used (the lag is no longer ours)
- Cash Flow Projection tile: starting balance = live bank balance, not Fortnox
- New tile (optional): "Today's bank activity" — last 5 transactions, with counterparty + amount

**Deliverable**: Vero's dashboard shows her actual real-time cash position. The −624k confusion from earlier is gone.

### Phase D — reconciliation flags (Weeks 7-8)

This is where the AI angle gets defensible.

- **POS-to-bank match**: pair POS daily Z-report totals with bank deposit transactions. Allow 1-5 day settlement lag (card processor delay). Flag unmatched: "Saturday's 28,400 kr Z-report has no matching deposit yet — settlement delay or skim?"
- **Supplier-invoice-to-bank-debit match**: pair unpaid supplier invoices (Fortnox) with bank debits matching the amount + within ~7 days of due date. Flag invoices marked unpaid that have a matching debit (booked but not marked paid in Fortnox).
- **Salary-payout sanity**: did the salary outflow we projected on the 25th actually happen? Flag if missing.
- **F-skatt-payout sanity**: same for 12th.

**Deliverable**: Vero gets actionable reconciliation flags. The Fortnox-vs-bank discrepancy from earlier today would have been auto-flagged.

### Phase E — rollout & customer onboarding (Week 9)

- Wire into onboarding wizard: bank connect is an optional step alongside Fortnox + PK
- Email template for the 80-day consent-expiring warning
- Documentation: "How CommandCenter uses your bank data" (FAQ for trust-skeptical customers)
- Roll out to Rosali + Chicce

**Deliverable**: all customers can connect their banks; renewal flow tested.

### Phase F — advanced (post-MVP, deferred)

- Tink migration if Nordigen rate limits bite at scale
- AI-driven transaction categorisation (we currently take provider's classification at face value; a Haiku 4.5 call per uncategorised transaction would dramatically improve quality)
- Cash flow forecasting *incorporating* live transaction patterns (e.g. "your card processor typically settles Saturdays on Wednesday — projecting Saturday deposit on Wednesday")
- Fraud detection — anomaly alerts on unusual outflows
- Multi-currency for businesses with foreign bank accounts (rare in SE restaurants)

## Cost estimate

| Item | Cost |
|---|---|
| Nordigen / GoCardless Bank Account Data | **0 SEK** (free tier covers our use case) |
| Engineering time | 6-8 weeks of focused work for MVP (Phases A-D) |
| Legal review | ~10k SEK for a one-time review of customer disclosures and consent UX (recommended) |
| **Total to MVP** | **~10k SEK + ~6-8 weeks** |

If we hit Nordigen rate limits at scale:
- Tink: 30-50k SEK setup + ~0.50 EUR/account/month (~5 SEK/account)
- At 50 customers × 2 accounts × 12 months = ~6,000 SEK/year ongoing

## Risks

1. **PSD2 consent expiry — 90 days, regulated, non-negotiable.** Customers must re-auth quarterly via BankID. This is friction. Mitigations:
   - Email at day 80 (10-day warning)
   - Dashboard banner at day 85 + a one-click "Reconnect" deep link
   - Grace period: cached balance shown for 5 days after expiry with explicit "stale" badge

2. **Bank coverage gaps.** Confirm Nordigen supports every SE bank our customers use:
   - Confirmed major: Handelsbanken, SEB, Swedbank, Nordea, Danske, SBAB, Länsförsäkringar Bank
   - Confirm before launch: ICA Banken, Marginalen, Ålandsbanken, smaller Sparbanken regional banks

3. **Customer trust hurdle.** Asking a restaurant owner to BankID-authenticate into their business bank is a bigger ask than the Fortnox OAuth they already trusted us with. Mitigations:
   - Explicit UX copy: "Read-only, can never move money, revoke anytime via your bank"
   - Show the customer the exact permission scope on the consent page
   - Reference the security page + DPA template (already drafted)
   - Customer can disconnect any time → cascades to status='revoked' and our sync stops

4. **Transaction-matching false positives.** Phase D reconciliation flags could be wrong if categorisation is imperfect. Always show the matched transaction with an "is this right?" thumb — owner can correct, our model learns.

5. **Multi-bank customers.** Some restaurants split operating account (Handelsbanken) and savings (SBAB or similar). Connection model supports multiple connections per business, but:
   - Which one drives the cash-position tile? Owner picks the "default for cash position" via `bank_accounts.default_for_cash_position`
   - Total across multiple accounts = sum of current_balance — straightforward but UI needs to show breakdown

6. **Provider downtime / API churn.** Nordigen / Tink occasionally have outages. Soft-fail to last-known balance; show staleness; don't break the dashboard.

7. **Regulatory: storage of bank transaction data.** Customer data; subject to GDPR + the customer DPA. Retention: as long as integration active + 90 days. Existing patterns at `lib/integrations/encryption.ts` + RLS policies + customer-deletion flow (already shipped) cover this.

## UX considerations

**Onboarding new customer:** Bank connect appears in the existing `/onboarding` Systems step alongside Fortnox + PK. Optional but recommended. Tooltip: "Connect for live cash position (vs Fortnox-booked which lags if your bookkeeping is behind)."

**Existing customer enabling later:** "Bank" row on `/integrations` with same OAuth confirmation modal (memory `feedback_oauth_business_confirmation.md` — same business-selection + tick-to-confirm requirement, even higher stakes here).

**Consent expiring:** 10 days out, in-app banner: "Reconnect your bank by 2026-08-12 to keep cash visibility working." One-click button starts the BankID flow. After expiry, banner shifts to "Bank connection expired — reconnect required. Cash position shown is from 2026-08-12 (3 days ago)."

**Multi-account business:** /integrations shows each account under the connection, with a checkbox "use this account for cash position." Owner can opt out of savings accounts cluttering the projection.

## Decisions to make before starting

1. **Provider: Nordigen or Tink?** Recommendation: Nordigen for free + EU + sufficient. Decide before writing any code; switching providers later means data migration.
2. **Which businesses get this in v1?** All? Or beta with Vero only? Recommendation: Vero in v1 (she's our willing test customer + has the exact pain point), Rosali + Chicce in v2 once we've debugged.
3. **Counterparty enrichment?** Banks return raw narratives like "FX SE 4471 MENIGO 559..." — useful but ugly. Do we ship raw, or invest in cleanup? Recommendation: raw in v1, cleanup in v2 with an AI helper.
4. **Pricing implications?** Bank feeds increase our cost-of-customer slightly (Nordigen free helps; engineering time is the real cost). Worth bundling into the Pro tier as a differentiator? Or available on all tiers? Recommendation: all tiers, since it's free at the API level and the value is universal.
5. **Where do bank transactions live in the dashboard navigation?** Sub-page under /financials? Standalone /bank route? Recommendation: integrated into existing cash tiles for v1; consider a dedicated /bank page in v2 once volume justifies it.

## What success looks like

After 8 weeks:
- Vero's Cash Position tile shows her actual live bank balance, refreshed every 4 hours
- The bookkeeping-lag warning chip is gone (no longer needed when source is live)
- Cash Flow Projection starts from real money, not Fortnox-booked money
- Reconciliation flags surface "deposit missed" / "invoice paid but not marked paid" issues automatically
- Customer-facing trust improves materially — we look like a serious financial product, not a dashboard

This is the single highest-leverage product feature we can ship in Q3 2026, in my opinion.

## References

- Memory `feedback_oauth_business_confirmation.md` — confirmation modal pattern; applies here even more strictly
- `feedback_fortnox_business_id_required.md` — guard against the same mis-binding class for bank connections
- `feedback_fortnox_token_refresh_required.md` — pattern for token-refresh; bank tokens behave similarly but with 90-day consent window
- `LEGAL-OBLIGATIONS.md` §7 sub-processors — add Nordigen here when signing on
- `CUSTOMER-DPA-TEMPLATE.md` Schedule C — Nordigen / GoCardless added as a sub-processor in the bank-enabled DPA variant

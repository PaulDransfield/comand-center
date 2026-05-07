# Fortnox API Endpoint Usage Audit
> Generated 2026-05-07 by Claude Code as Phase 1, Question 1 deliverable.
> Read-only investigation. No code changed during production.

## TL;DR

- **Zero wrapper functions in `lib/fortnox/`.** Every Fortnox HTTP call is inline in route files or in `lib/sync/engine.ts`. There is no shared `fortnoxApi.get(...)` client today.
- **Two parallel sync paths exist for Fortnox** — `app/api/integrations/fortnox/route.ts` and `lib/sync/engine.ts::syncFortnox` (called by `runSync`). They write to different tables, are triggered by different code paths, and partially overlap in what they fetch.
- **Path A (lib/sync/engine.ts) already calls `/vouchers`** — but only the list endpoint, no per-voucher detail fetch, and the resulting rows go to `financial_logs`, which **no other code path reads**. The Fortnox voucher data ingested daily via master-sync is currently write-only.
- **Path B (app/api/integrations/fortnox) writes directly to `tracker_data`** with `source='fortnox'`, bypassing the canonical `projectRollup` writer documented in `CLAUDE.md`.
- **Five distinct active endpoints** are exercised in production sync flows: `POST /oauth-v1/token` (init + refresh), `GET /3/supplierinvoices`, `GET /3/invoices`, `GET /3/vouchers`. The PDF-extraction pipeline calls zero Fortnox endpoints.
- **Six endpoints are defined in `lib/api-discovery/fortnox.ts` and `lib/agents/live-api-prober.ts` but never feed customer-facing data**: `/articles`, `/customers`, `/suppliers`, `/orders`, `/offers`, `/financialyears`. They run only inside background discovery / probing cron jobs that write to `api_probe_results` and `api_discoveries`, not into the P&L pipeline.

## 1. lib/fortnox/ wrapper functions

**Result: there are none.**

The four files in `lib/fortnox/` do not call the Fortnox HTTP API. They are pure logic / Anthropic-only:

| File | Calls Fortnox API? |
|---|---|
| `lib/fortnox/classify.ts` | No — pure classifiers |
| `lib/fortnox/resultatrapport-parser.ts` | No — operates on PDF buffers |
| `lib/fortnox/validators.ts` | No — pure validation |
| `lib/fortnox/ai-auditor.ts` | No — calls Anthropic only |

Implication for Phase 2: there is no shared client to extend. A Phase 2 build would either (a) lift the inline calls from the two route files into a shared `lib/fortnox/api/*.ts` module, or (b) write the new client from scratch alongside the existing inline code. The minimal Phase 1 voucher fetcher this prompt asks for is the same minimal code, written once.

## 2. Every Fortnox API call site, by file

### `app/api/integrations/fortnox/route.ts` — Path B (customer-triggered)

| Endpoint | Method | Function | Line | Purpose |
|---|---|---|---|---|
| `apps.fortnox.se/oauth-v1/token` | POST | `handleCallback` (inline) | 165 | Authorisation-code exchange on OAuth callback |
| `apps.fortnox.se/oauth-v1/token` | POST | `refreshToken` (inline) | 508 | Manual refresh-token exchange |
| `api.fortnox.se/3/supplierinvoices?fromdate=&todate=` | GET | `syncFortnox > fortnoxGet` | 331 | Fetch supplier invoices for current month |
| `api.fortnox.se/3/invoices?fromdate=&todate=` | GET | `syncFortnox > fortnoxGet` | 332 | Fetch sales invoices for current month |

Triggered by:
- The customer clicking Connect on `/integrations` (callback fetch + immediate background sync via `syncFortnoxInBackground` line 234)
- `POST /api/integrations/fortnox` with `{action:'sync'}` from anywhere; rate-limited to 20/hour/user

Writes to: `tracker_data` (upsert with `source='fortnox'`, `onConflict='business_id,period_year,period_month'`); also updates `integrations.last_sync_at / status / last_error`.

### `lib/sync/engine.ts` — Path A (cron + admin-triggered)

| Endpoint | Method | Function | Line | Purpose |
|---|---|---|---|---|
| `apps.fortnox.se/oauth-v1/token` | POST | `ensureFreshFortnoxToken` (inline) | 487 | Refresh on every sync if token expires within 5 min |
| `api.fortnox.se/3/supplierinvoices?filter=all&fromdate=&todate=&limit=500` | GET | `syncFortnox` (inline) | 533 | Fetch supplier invoices; writes one row per invoice to `financial_logs` |
| `api.fortnox.se/3/vouchers?fromdate=&todate=` | GET | `syncFortnox` (inline) | 571 | Fetch voucher list; writes one row per voucher to `financial_logs` |

Triggered by:
- `POST /api/sync` (user-triggered)
- `POST /api/sync/today` (user-triggered)
- `POST /api/resync` (user-triggered)
- `POST /api/admin/v2/sync` (admin-triggered)
- `POST /api/cron/master-sync` (Vercel cron 05:00 UTC) — `from = now − 90d, to = now`
- `POST /api/cron/catchup-sync` (Vercel cron hourly 6–23 UTC)

Writes to: `financial_logs` only.

**Important:** the voucher fetch only retrieves the LIST response (`{Vouchers: [...]}`). It does NOT call `GET /3/vouchers/{series}/{number}` to retrieve the per-voucher row detail. The list response shape uses `TransactionInformation` as the amount field at line 584; this is not the line-item-level data needed to produce a P&L. As a result the data sitting in `financial_logs` is summary-only.

### `app/api/cron/health-check/route.ts:178` — health probe

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `api.fortnox.se/3/` | GET | unauthenticated | Liveness check on the Fortnox base URL |

Triggered by: Vercel cron `/api/cron/health-check` (06:00 UTC daily).

This is not a per-customer connection check. The "real" call (`/3/companyinformation` with the customer's bearer token) is in a code comment immediately above the actual call.

### `lib/api-discovery/fortnox.ts::analyzeFortnoxAPI` — discovery-only

| Endpoint | Method | Purpose |
|---|---|---|
| `/3/supplierinvoices` | GET | Schema discovery |
| `/3/invoices` | GET | Schema discovery |
| `/3/vouchers` | GET | Schema discovery |
| `/3/articles` | GET | Schema discovery |
| `/3/customers` | GET | Schema discovery |
| `/3/suppliers` | GET | Schema discovery |
| `/3/orders` | GET | Schema discovery |
| `/3/offers` | GET | Schema discovery |

Triggered by: `app/api/cron/api-discovery/route.ts` only.

Writes to: `api_discoveries`, `api_probe_results` (the discovery feedback loop), not `tracker_data`, `monthly_metrics`, `daily_metrics`, `financial_logs`, or any other customer P&L table. Five of the eight endpoints (`/articles`, `/customers`, `/suppliers`, `/orders`, `/offers`) are not exercised by any other code path.

### `lib/agents/live-api-prober.ts` — agent probing

The agent's `COMMON_PROVIDERS` config (line 81) lists 7 endpoints under Fortnox: `/customers`, `/invoices`, `/articles`, `/orders`, `/supplierinvoices`, `/vouchers`, `/financialyears`. Triggered by `app/api/cron/live-api-prober/route.ts`. Writes to `api_probe_results`. `/financialyears` is the only one mentioned here that doesn't appear in any other path.

## 3. Categorisation summary

| Endpoint | Active in cron | Active in user-flow | Admin/debug only | Defined but unused | Notes |
|---|---|---|---|---|---|
| `POST /oauth-v1/token` (auth-code) | — | ✅ Path B callback | — | — | Once per connect |
| `POST /oauth-v1/token` (refresh) | ✅ Path A every sync | ✅ Path B sync | — | — | Two implementations: `lib/sync/engine.ts:487` and `app/api/integrations/fortnox/route.ts:508` |
| `GET /3/supplierinvoices` | ✅ master-sync, catchup-sync | ✅ Path B sync | ✅ discovery cron | — | Path A uses `filter=all&limit=500`; Path B uses neither |
| `GET /3/invoices` | — | ✅ Path B sync | ✅ discovery cron | — | Only Path B fetches sales invoices in production |
| `GET /3/vouchers` (list) | ✅ master-sync, catchup-sync | — | ✅ discovery cron | — | Already wired but only writes summary to `financial_logs` |
| `GET /3/vouchers/{series}/{number}` (detail) | — | — | — | ✅ never called | Phase 2 needs this for line-level data |
| `GET /3/articles` | — | — | ✅ discovery only | ✅ no consumer | |
| `GET /3/customers` | — | — | ✅ discovery only | ✅ no consumer | |
| `GET /3/suppliers` | — | — | ✅ discovery only | ✅ no consumer | |
| `GET /3/orders` | — | — | ✅ discovery only | ✅ no consumer | |
| `GET /3/offers` | — | — | ✅ discovery only | ✅ no consumer | |
| `GET /3/financialyears` | — | — | ✅ probe only | ✅ no consumer | Mentioned in live-api-prober only |
| `GET /3/companyinformation` | — | — | — | ✅ never called | OAuth scope requested, never used |
| `GET /3/accounts` / `accountcharts` | — | — | — | ✅ never called | Chart of accounts hardcoded in `classify.ts` and `app/api/integrations/fortnox/route.ts:365-376` |
| `GET /3/employees` / `salarytransactions` / `attendancetransactions` | — | — | — | ✅ never called | OAuth `salary` scope requested, never used |
| `GET /3/inbox` / `archive` | — | — | — | ✅ never called | PDFs are stored locally in Supabase, not retrieved from Fortnox archive |
| `GET /3/costcenters` / `projects` | — | — | — | ✅ never called | |

## 4. Persistence path — what each active endpoint produces

| Endpoint | Response shape | Persisted to | Read by |
|---|---|---|---|
| `/supplierinvoices` (Path A, lib/sync/engine.ts) | `data.SupplierInvoices[]` summary records | `financial_logs` (`log_type='invoice'`, full record in `raw_data`) | **Nothing** — `financial_logs` has no readers in app code. |
| `/vouchers` (Path A, lib/sync/engine.ts) | `data.Vouchers[]` summary | `financial_logs` (`log_type='journal'`, summary only — no per-row breakdown) | **Nothing** — same. |
| `/supplierinvoices` (Path B, integrations/fortnox) | `data.SupplierInvoices[]` summary | Aggregated into `tracker_data` columns (`food_cost`, `staff_cost`, `rent_cost`, `other_cost`) via the inline 30-entry BAS map at line 365 | `/api/tracker`, Performance page, aggregator (`monthly_metrics`) |
| `/invoices` (Path B) | `data.Invoices[]` summary | Summed into `tracker_data.revenue` (skipping `Cancelled: true`) | `/api/tracker`, Performance page |
| `POST /oauth-v1/token` | `{access_token, refresh_token, expires_in}` | `integrations.credentials_enc` (encrypted JSON) | `ensureFreshFortnoxToken`, `syncFortnox` |
| `https://api.fortnox.se/3/` (health-check) | HTTP status only | `integration_health_checks` | `/admin/v2/health` UI |

## 5. The `financial_logs` finding

`financial_logs` is written by exactly two sites — both in `lib/sync/engine.ts` (lines 544 and 578). Searching the entire codebase for `from('financial_logs')` returns zero read sites in app code. The aggregator (`lib/sync/aggregate.ts`) does NOT read from `financial_logs` — it reads from `revenue_logs` (POS), `staff_logs` (PK), and `tracker_data` (PDF apply + Path B sync), then writes to `daily_metrics` / `monthly_metrics` / `dept_metrics`.

`updateTrackerFromLogs` (called from `runSync` after every provider sync, lib/sync/engine.ts:864) reads `staff_logs` and `revenue_logs` to compute monthly aggregates, but does NOT read `financial_logs`. Fortnox-API supplier-invoice and voucher data never reaches `tracker_data` via Path A.

The M012 schema declaration of `financial_logs` (sql/M012-orphan-tables.sql:115) carries the comment "Aggregate financial events. May be deprecated in favour of monthly_metrics." The schema in M012 also does not match what `syncFortnox` actually writes — M012 declares `(metric, value, source)` columns, but the writer expects `(provider, source_id, log_type, amount, vat_amount, vendor_name, vendor_number, transaction_date, period_year, period_month, description, raw_data)`. The writer must be relying on a later schema migration or production-applied schema that this audit cannot verify without DB access.

Implication: any verification harness that re-derives metrics from API-fetched vouchers cannot cross-check against `financial_logs` content alone, because the data shape there is summary-only and was never reconciled to a P&L. The verification has to compare the *new* harness output against `tracker_data` / `monthly_metrics` populated by the PDF apply path.

## 6. Path A vs Path B divergences

| Concern | Path A (lib/sync/engine.ts) | Path B (app/api/integrations/fortnox) |
|---|---|---|
| Trigger | Cron + admin + `/api/sync` user trigger | Customer "Connect" + `POST /api/integrations/fortnox` |
| Token refresh threshold | <5 min to expiry (line 477) | <60 min to expiry (line 289) |
| Endpoints called | `/supplierinvoices` (limit=500), `/vouchers` | `/supplierinvoices`, `/invoices` |
| Pagination | `&limit=500` requested but no follow-up call if more rows exist | None — single call |
| Cancelled invoice filter | None | `if (!inv.Cancelled)` on sales invoices |
| Revenue capture | Not derived (vouchers don't compute revenue summary in this path) | Sum of non-cancelled `inv.Total` |
| Cost classification | None — raw rows persisted | 30-entry hardcoded BAS account map at line 365 + supplier-name keyword fallback |
| Writes to | `financial_logs` only | `tracker_data` directly with `source='fortnox'` |
| Idempotency key | `(org_id, provider, source_id)` per invoice/voucher | `(business_id, period_year, period_month)` upsert |
| Rate-limit awareness | None inline | `rateLimit(auth.userId, max:20/hr)` at the route layer |
| Failure mode | Inner try/catch with `console.error`; partial success swallowed | Inner try/catch with `last_error` written to `integrations` row |

Note: both paths use the same `FORTNOX_CLIENT_ID` / `FORTNOX_CLIENT_SECRET` env vars and the same `integrations` table for token storage. Either can refresh the other's token. They are not isolated.

## 7. Tested-only references

- `test_suite.py` — Python harness, references Fortnox endpoints in test fixtures
- `scripts/test-api-discovery.js` — discovery test
- `scripts/test-live-api-prober.ts` — live-api-prober test
- `tests/fortnox-fixtures/README.md` — PDF fixtures for the Resultatrapport parser

None of these participate in production data flow.

## 8. Open questions raised by this audit

1. **Is the Path A → `financial_logs` write path intentional or vestigial?** Phase 1 cannot tell. It runs daily via master-sync against any connected Fortnox integration but produces data that nothing reads. Either the readers were removed in a refactor, or the path was wired before the canonical PDF + projectRollup architecture and never decommissioned.

2. **Has any Fortnox OAuth integration row in production ever populated `financial_logs` and `tracker_data` simultaneously for the same customer?** If yes, the two writers can disagree (Path A writes raw events, Path B writes aggregated rollups). Determining this requires DB access and is out of Phase 1 scope.

3. **Why does `ensureFreshFortnoxToken` exist twice?** Both `lib/sync/engine.ts:465` and `app/api/integrations/fortnox/route.ts:484` implement effectively the same logic with slightly different thresholds. Cleanup item, not Phase 1 scope.

4. **The voucher list response amount (`v.TransactionInformation`) is being parsed as `parseFloat` and stored in `financial_logs.amount`.** Per Fortnox documentation `TransactionInformation` is a free-text description field, not a numeric amount. Voucher line totals require the per-voucher detail call (`GET /3/vouchers/{series}/{number}`). This may be a pre-existing bug; it is not Phase 1's job to fix it but it materially affects whether anything in `financial_logs` can be trusted at face value.

5. **Of the 233 endpoints in the v3 spec, how many are actually relevant to a restaurant SaaS?** This audit only enumerates what's already referenced. A Phase 2 scope discussion needs the spec in hand at `vendor/fortnox-openapi.json` (not present in repo at audit time) to filter to the ~15-25 endpoints likely needed for full P&L + master-data sync.

## 9. Phase 2 implication (fact-only, no recommendation)

A Phase 2 backfill that promises "API-driven onboarding" needs to:

- Add line-level voucher detail (`GET /3/vouchers/{series}/{number}`) — currently no code does this
- Reconcile or replace one of the two parallel sync paths — running both will produce divergent `tracker_data` (Path B) vs `financial_logs` (Path A) for the same customer
- Decide what the canonical writer is — `projectRollup` per CLAUDE.md, or the inline `tracker_data` upsert in Path B, or something new
- Reuse the classifier in `lib/fortnox/classify.ts` rather than the inline 30-entry map
- Build pagination handling — Path A's `&limit=500` is the only attempt and has no follow-up

The Phase 1 voucher fetcher and translation layer below are the minimal scaffolding to test whether voucher-derived P&L matches PDF-derived P&L. They do not resolve the architectural questions above.

> "Audit complete. No code was changed during its production."

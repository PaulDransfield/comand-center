# Fortnox local-cache architecture plan

> Drafted 2026-05-09 after Vero onboarding revealed that "fetch from Fortnox on every dashboard load" doesn't scale beyond a handful of customers. Stash this for the next session — not blocking anything tonight.

## Problem

Every customer-facing surface that needs Fortnox data currently hits Fortnox's API on demand:

| Surface | Endpoint | Fortnox call(s) per render |
|---|---|---|
| Dashboard Recent Invoices | `/api/integrations/fortnox/recent-invoices` | 1 list call (uncached) or 0 (cache hit, 5 min) |
| Overheads drilldown (per flag) | `/api/integrations/fortnox/drilldown` | 1 list + N voucher details |
| PDF view (per click) | `/api/integrations/fortnox/invoice-pdf` → `/file` | 1 detail + 1 binary |
| Backfill worker | `/api/cron/fortnox-backfill-worker` | 1 financialyears + N list pages + M detail GETs |

Two scaling problems:

1. **Rate limits.** Fortnox documents 25 req/5sec per token (real-world ~18 before 429s). At 50 customers × 4-page-loads/day × 5-widget loads = ~1000 user-triggered Fortnox calls/day, plus background backfill sync. Bursts (lunch-hour traffic, all owners checking simultaneously) easily exceed budget. Today's 429 retry-with-backoff is reactive — patches symptoms, doesn't fix the cause.
2. **Latency.** Live `/supplierinvoices` round-trip is 500-1500 ms on average, more during throttled retries. Every dashboard load eats that latency. With dozens of customers loading concurrently, P95 climbs.

## Goal

User-facing surfaces read from our own DB. Sync workers reconcile with Fortnox in the background, on a cadence appropriate to each data type. Hot-path Fortnox calls only for: (a) PDF binary fetches, (b) on-demand drill-into actions, (c) initial customer onboarding.

## Architecture

### Storage

**M063 — `fortnox_supplier_invoices`** (proposed)

```sql
CREATE TABLE fortnox_supplier_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,

  -- Fortnox identity
  given_number    TEXT NOT NULL,         -- canonical id (string-typed for safety)
  invoice_number  TEXT,                  -- supplier-side number
  supplier_name   TEXT NOT NULL,
  supplier_normalised TEXT,              -- for fuzzy matching across spelling variants

  -- Dates + money
  invoice_date    DATE NOT NULL,
  bookkeeping_date DATE,
  due_date        DATE,
  total           NUMERIC(14, 2),
  currency        TEXT,                  -- usually SEK
  vat             NUMERIC(14, 2),

  -- Voucher linkage (for joining drilldown to vouchers)
  voucher_series  TEXT,
  voucher_number  INTEGER,

  -- File metadata — populated on first detail-fetch, lazy
  file_id         TEXT,                  -- NULL until we've pulled detail
  file_id_fetched_at TIMESTAMPTZ,
  has_pdf         BOOLEAN GENERATED ALWAYS AS (file_id IS NOT NULL) STORED,

  -- Misc
  comments        TEXT,
  cancelled       BOOLEAN NOT NULL DEFAULT FALSE,
  raw_data        JSONB,                 -- full Fortnox response for debugging

  -- Sync telemetry
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT unique_business_given UNIQUE (business_id, given_number)
);

CREATE INDEX idx_fsi_business_date     ON fortnox_supplier_invoices (business_id, invoice_date DESC);
CREATE INDEX idx_fsi_business_supplier ON fortnox_supplier_invoices (business_id, supplier_normalised);
CREATE INDEX idx_fsi_voucher_link      ON fortnox_supplier_invoices (business_id, voucher_series, voucher_number) WHERE voucher_series IS NOT NULL;

ALTER TABLE fortnox_supplier_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY fsi_read ON fortnox_supplier_invoices FOR SELECT
  USING (org_id IN (SELECT org_id FROM organisation_members WHERE user_id = auth.uid()));
```

Optionally also: `fortnox_sync_state` table tracking the last successful sync timestamp per (business, resource) so the worker knows where to resume.

### Sync worker

**`/api/cron/fortnox-supplier-sync`** — runs daily (or every 4 hours for active customers)

Per business with a connected Fortnox integration:

1. Look up `fortnox_supplier_invoices.MAX(last_synced_at)` for this business
2. Compute `cursor = MAX(last_synced_at) - 24h` to catch any back-dated entries
3. `GET /supplierinvoices?fromdate=<cursor>&todate=<today>&limit=500` (paginate if needed)
4. UPSERT each invoice into `fortnox_supplier_invoices` keyed `(business_id, given_number)`
5. Don't fetch detail — `file_id` stays NULL until the first PDF view click

For new customers (no rows yet), fall through to a one-time backfill: same as the existing voucher backfill worker, but for supplier invoices. Only goes back ~12-24 months by default.

Cost model: 1 Fortnox call per business per sync interval, regardless of dashboard traffic. 50 customers × 4 syncs/day = 200 Fortnox calls/day for this resource — well under any rate limit.

### On-demand PDF fetch (unchanged shape, faster path)

`/api/integrations/fortnox/invoice-pdf?business_id=X&given_number=Y` becomes:

1. SELECT `file_id` from `fortnox_supplier_invoices` for `(business_id, given_number)`
2. If `file_id IS NOT NULL` → 302 to `/api/integrations/fortnox/file?...&file_id=Y`
3. If `file_id IS NULL` → on-demand detail fetch from Fortnox, UPSERT the result, then 302
4. If detail fetch returns no file_connections → 404 "no PDF attached"

Subsequent clicks for the same invoice are instant (file_id cached). PDF binary fetch goes to Fortnox always — never store binaries in our DB.

### Reader endpoints — refactored

`/api/integrations/fortnox/recent-invoices`:
```sql
SELECT supplier_name, given_number, invoice_number, invoice_date,
       total, currency, has_pdf, voucher_series, voucher_number, comments
FROM fortnox_supplier_invoices
WHERE business_id = $1 AND invoice_date >= NOW() - INTERVAL '$2 days'
  AND cancelled = false
ORDER BY invoice_date DESC LIMIT $3
```
Zero Fortnox calls. Returns in ~30 ms.

`/api/integrations/fortnox/drilldown`:
- Voucher data: still uses the `fetchVouchersForRange` pipeline (vouchers move into a similar local cache in Phase 2 — see below)
- Supplier-invoice metadata: read from `fortnox_supplier_invoices` directly via the voucher-series/number join. No live Fortnox call needed.

### Webhooks (Phase 3, optional)

Fortnox supports webhook subscriptions. Register on customer connect for: `supplier_invoice.created`, `supplier_invoice.updated`, `supplier_invoice.cancelled`. The hook handler updates our table. Eliminates polling latency entirely for new invoices.

We hold off on this until: (a) customer base justifies the engineering, (b) we trust webhook reliability (need a daily reconciliation sync as backstop anyway).

## Phasing

### Phase 1 — supplier invoices (the urgent one)
1. M063 schema migration
2. New cron `/api/cron/fortnox-supplier-sync` (daily, all customers)
3. Refactor `/api/integrations/fortnox/recent-invoices` → reads from table
4. Refactor `/api/integrations/fortnox/drilldown` → joins to table for supplier metadata
5. Refactor `/api/integrations/fortnox/invoice-pdf` → checks table for file_id first, lazy-fetches if missing
6. One-time backfill of existing customers' supplier invoices (admin button, similar to voucher backfill)

Estimate: 1-2 days focused work.

### Phase 2 — vouchers + line items
Same pattern for `/vouchers` data. Currently the backfill writes voucher-derived totals into `tracker_data`, but the raw voucher rows aren't kept. For the drilldown to work without re-fetching vouchers, we'd need:
- `fortnox_vouchers` table (or just `fortnox_voucher_rows`)
- Backfill worker writes both `tracker_data` rollup AND voucher rows to the table
- Drilldown reads from the local table for cost-row aggregation per category

Bigger work — defer to after Phase 1 ships.

### Phase 3 — webhooks
Once we have ≥10 active customers and Phase 1 + 2 are stable.

## What this leaves us without

- **Real-time freshness < 4 hours.** A supplier invoice booked into Fortnox at 09:00 won't show on the dashboard until the next sync. Mitigation: shorten sync interval to 1 hour for active customers, or wire webhooks (Phase 3) for instant updates.
- **PDF binaries still proxied live.** Each PDF view = 1 Fortnox call. Acceptable — owners click maybe 5-10 PDFs per session. Low volume.
- **Initial onboarding still hits Fortnox heavily.** First-time backfill of months of data. That's fine; onboarding is rare.

## Non-goals

- Don't try to mirror EVERY Fortnox endpoint. Only the resources we actually read in user-facing surfaces (supplier invoices, vouchers, financial years).
- Don't store PDF binaries — too expensive at scale, and Fortnox is the canonical store anyway.
- Don't try to make this transactional with Fortnox — eventual consistency (≤4 hours behind) is fine.

## When to start

After tonight's onboarding settles. Vero is fine on the current path with 429 retry; it's the only customer. The right time is when we're about to onboard customer #2 or #3 — that's when the call-count math starts to matter.

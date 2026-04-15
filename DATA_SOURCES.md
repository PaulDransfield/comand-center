# DATA_SOURCES.md — CommandCenter Data Consistency Guide
> Version 1.0 | Created: 2026-04-11
> Read this before building any integration, sync, or analytics feature.

---

## The core problem

CommandCenter pulls data from up to three systems simultaneously:

- **Personalkollen** — staff shifts, actual hours, OB supplements, and (sometimes) sales
- **POS system** (Ancon, Swess, Trivec) — live sales, covers, cash/card splits, tips
- **Fortnox** — invoices, supplier costs, payroll, P&L

These systems overlap. They don't always agree. The same revenue number will appear differently in each system — and that is not a bug, it is reality. Tips appear in POS but not Fortnox. Invoices are created days after the sale. Payroll is processed monthly but shifts happen daily.

**The rule: never merge sources automatically. Never force numbers to match. Show the difference and let the owner investigate.**

---

## 1. Source of truth per metric

This table is the single most important thing in this file. Every query, every dashboard KPI, every forecast must respect these rules.

| Metric | Source of truth | Why | Other sources role |
|--------|----------------|-----|-------------------|
| Revenue — invoiced (monthly, annual) | Fortnox | Legally binding, matches tax filing | POS for live estimate only |
| Revenue — live (today, this week) | POS | Real-time, includes tips, cash | Fortnox for end-of-month adjustment |
| Revenue — current month (open) | POS | Not yet invoiced | Fortnox will catch up at close |
| Revenue — closed month | Fortnox | Final, matches accounts | POS for retrospective comparison |
| Labour hours — actual | Personalkollen | Clock-in/out is ground truth | Fortnox salary for final payroll check |
| Labour hours — scheduled | Personalkollen | Source of schedule data | — |
| Labour cost — estimated | Personalkollen hours × wage rate | Best available estimate | Fortnox salary transactions |
| Labour cost — final (payroll) | Fortnox salary transactions | Legally processed payroll | Personalkollen for variance |
| COGS — purchased | Fortnox supplier invoices | What was actually paid | POS purchase orders (planned) |
| COGS — consumed | POS + recipe data | Actual usage | Fortnox for total purchased |
| Fixed costs (rent, utilities) | Fortnox supplier invoices | Only reliable source | — |
| Stock on hand | Fortnox stock balance | Accounting system | POS usage for discrepancy check |

**Key rule for the tracker page**: When a month is still open (current month), show POS revenue. When a month is closed (past month), show Fortnox revenue. Label which source is being used so the owner understands.

**Key rule for forecasting**: Always train on Fortnox historical data (it matches what was filed). Use POS for short-term (today/this week) corrections only.

---

## 2. Why numbers will differ — expected discrepancies

This is normal. Do not try to fix these automatically.

| Discrepancy | Most likely cause | How to show it |
|-------------|------------------|----------------|
| POS revenue > Fortnox invoices | Tips not invoiced, cash sales, timing (POS is live, Fortnox is delayed) | "POS: 42,300 kr / Fortnox: 41,100 kr / Difference: 1,200 kr (tips/timing)" |
| POS revenue < Fortnox invoices | B2B or event invoices not processed through POS, credit notes | Flag and show both |
| Personalkollen hours ≠ Fortnox salary | Overtime pending approval, sick leave adjustments, different pay period cut-offs | Show per-employee variance on payroll close |
| Fortnox stock ≠ POS usage | Waste, theft, portion variance, incorrect recipe setup | Flag for stock-take |
| Personalkollen shows sales, POS also shows sales | Some restaurants log sales in both — Personalkollen sales data for those restaurants should be ignored in favour of POS | Check integration config per business |

---

## 3. Database design — store with source tags, never merge

Every revenue, labour, and cost event must carry a `source` column. This is the foundation that prevents double-counting.

```sql
-- Revenue events: one row per sale, one row per invoice — never summed together
CREATE TABLE revenue_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id  UUID REFERENCES businesses(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,       -- 'personalkollen' | 'pos_ancon' | 'pos_swess' | 'fortnox' | 'manual'
  source_id    TEXT NOT NULL,       -- original ID from that system (POS transaction ID, invoice number)
  event_date   DATE NOT NULL,
  amount       NUMERIC NOT NULL,    -- revenue amount in SEK
  tax_amount   NUMERIC DEFAULT 0,
  covers       INTEGER DEFAULT 0,   -- guests (if available)
  cost_center  TEXT,                -- 'bar' | 'restaurant' | 'takeaway' | department name
  raw_data     JSONB,               -- original payload — never delete this
  synced_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source, source_id)         -- prevent duplicates from re-syncing
);

-- Reconciliation matches — link events across sources
CREATE TABLE revenue_reconciliation (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID,
  business_id         UUID,
  primary_event_id    UUID REFERENCES revenue_events(id),  -- Fortnox invoice
  secondary_event_id  UUID REFERENCES revenue_events(id),  -- POS sale
  match_date          DATE,
  difference_amount   NUMERIC,      -- primary - secondary
  difference_pct      NUMERIC,      -- abs difference as % of primary
  status              TEXT DEFAULT 'pending',  -- 'matched' | 'unmatched' | 'accepted' | 'explained'
  explanation         TEXT,         -- owner's note if they accepted the difference
  matched_at          TIMESTAMPTZ DEFAULT now()
);
```

**Query pattern — never sum across sources:**
```sql
-- WRONG: sums POS + Fortnox = double counts
SELECT SUM(amount) FROM revenue_events WHERE business_id = $1 AND event_date = $2

-- CORRECT: pick the right source for the context
-- For live dashboard (current month open):
SELECT SUM(amount) FROM revenue_events
WHERE business_id = $1 AND event_date BETWEEN $2 AND $3 AND source LIKE 'pos_%'

-- For closed months (Fortnox is ground truth):
SELECT SUM(amount) FROM revenue_events
WHERE business_id = $1 AND event_date BETWEEN $2 AND $3 AND source = 'fortnox'
```

---

## 4. Per-business source configuration

Each business may have different systems connected. The sync engine must know which system is the revenue source of truth for that business.

```sql
-- Add to businesses table
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS revenue_source TEXT DEFAULT 'personalkollen';
-- Values: 'personalkollen' | 'pos_ancon' | 'pos_swess' | 'fortnox' | 'manual'

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS labour_source TEXT DEFAULT 'personalkollen';
-- Values: 'personalkollen' | 'fortnox_salary'

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS cogs_source TEXT DEFAULT 'fortnox';
-- Values: 'fortnox' | 'pos' | 'manual'
```

**Example configuration:**
- Business A (Personalkollen logs sales): `revenue_source = 'personalkollen'`
- Business B (separate POS, Personalkollen for staff only): `revenue_source = 'pos_ancon'`
- Business C (Fortnox as main system, no POS integration): `revenue_source = 'fortnox'`

The dashboard, tracker, and forecast pages must read `businesses.revenue_source` before deciding which table to query.

---

## 5. Sync engine rules — how to handle each source

### When Personalkollen is the revenue source
- Store sales from Personalkollen in `revenue_events` with `source = 'personalkollen'`
- These are the numbers shown on dashboard
- If Fortnox also connects later, do NOT replace — reconcile instead

### When a POS is connected
- Store POS sales in `revenue_events` with `source = 'pos_ancon'` (or relevant POS)
- Update `businesses.revenue_source = 'pos_ancon'`
- If Personalkollen also has sales data for this business — IGNORE Personalkollen sales, use POS only
- Keep Personalkollen for staff/labour data only

### When Fortnox connects
- Store invoices in `revenue_events` with `source = 'fortnox'`
- Do NOT replace existing POS/Personalkollen revenue — run reconciliation instead
- Update tracker_data with Fortnox P&L for closed months
- Fortnox supplier invoices go to `purchase_events` table

### Priority order when multiple sources have revenue
```
POS system > Personalkollen > Fortnox (for live/current)
Fortnox > POS > Personalkollen (for closed/historical)
```

---

## 6. Reconciliation logic

Run a daily reconciliation job at 02:00 UTC (before the 06:00 sync).

```typescript
// app/api/cron/reconcile/route.ts
// Schedule: "0 2 * * *" in vercel.json

async function reconcileRevenue(businessId: string, date: string) {
  const db = createAdminClient()

  // Get all revenue events for this business on this date, grouped by source
  const { data: events } = await db
    .from('revenue_events')
    .select('*')
    .eq('business_id', businessId)
    .eq('event_date', date)

  const bySource = groupBy(events, 'source')

  // If both POS and Fortnox have data for the same day, reconcile
  if (bySource.fortnox && (bySource.pos_ancon || bySource.pos_swess)) {
    const fortnoxTotal = sum(bySource.fortnox, 'amount')
    const posSource    = bySource.pos_ancon ?? bySource.pos_swess
    const posTotal     = sum(posSource, 'amount')
    const diffPct      = Math.abs(fortnoxTotal - posTotal) / fortnoxTotal * 100

    await db.from('revenue_reconciliation').upsert({
      business_id:         businessId,
      match_date:          date,
      difference_amount:   fortnoxTotal - posTotal,
      difference_pct:      diffPct,
      status:              diffPct <= 5 ? 'matched' : 'unmatched',
    }, { onConflict: 'business_id,match_date' })

    // Create anomaly alert if difference is large
    if (diffPct > 10) {
      await db.from('anomaly_alerts').upsert({
        alert_type:    'revenue_discrepancy',
        severity:      diffPct > 20 ? 'high' : 'medium',
        title:         `Revenue discrepancy: ${diffPct.toFixed(1)}% difference`,
        description:   `POS reports ${posTotal.toLocaleString()} kr, Fortnox shows ${fortnoxTotal.toLocaleString()} kr on ${date}. Difference of ${Math.abs(fortnoxTotal - posTotal).toLocaleString()} kr. Common causes: tips, timing, cash sales.`,
        metric_value:  diffPct,
        expected_value: 0,
        deviation_pct: diffPct,
        period_date:   date,
      }, { onConflict: 'business_id,alert_type,period_date' })
    }
  }
}
```

### Tolerance thresholds
| Metric | Acceptable difference | Alert threshold |
|--------|----------------------|-----------------|
| Daily revenue | ≤5% | >10% |
| Monthly revenue | ≤2% | >5% |
| Labour hours | ≤1 hour/week | >3 hours/week |
| COGS % | ≤2pp | >5pp |

---

## 7. How to display discrepancies to customers

Never hide differences. Show them honestly with context.

**On the tracker page (monthly P&L):**
```
Revenue (this month):
  POS:      42,300 kr  ← live, includes tips
  Fortnox:  41,100 kr  ← invoiced, excludes tips
  Difference: 1,200 kr (2.8%) — within normal range
```

**On the dashboard (current month):**
- Show POS revenue as primary number
- Small badge: "Fortnox: 41,100 kr when available"

**On the alerts page:**
- Discrepancy alerts with explanation of likely cause
- Button: "Mark as explained" + free text field

**In the AI assistant:**
When a customer asks "what was my revenue last month?" — Claude should respond:
```
"Your POS recorded 42,300 kr in October. Your Fortnox invoices show 41,100 kr — 
the 1,200 kr difference is likely tips and cash sales that weren't invoiced. 
For tax purposes, use the Fortnox figure."
```

---

## 8. Tracker page — which source per period

The tracker page (monthly P&L) must use the right source for each month:

```typescript
function getRevenueSource(periodYear: number, periodMonth: number, business: Business): string {
  const now = new Date()
  const isCurrentMonth = periodYear === now.getFullYear() && periodMonth === now.getMonth() + 1
  const isPastMonth    = new Date(periodYear, periodMonth - 1) < new Date(now.getFullYear(), now.getMonth())

  if (isCurrentMonth) {
    // Current month — use POS or Personalkollen (live)
    return business.revenue_source // 'pos_ancon' | 'personalkollen'
  }

  if (isPastMonth && business.fortnox_connected) {
    // Past month with Fortnox — use Fortnox (final)
    return 'fortnox'
  }

  // Past month without Fortnox — use whatever source is available
  return business.revenue_source
}
```

Show a small label next to the revenue figure: "(from POS)" or "(from Fortnox)".

---

## 9. Forecasting rules

The forecast model must use the correct source to avoid systematic bias.

**Training data**: Always use Fortnox revenue for closed months (it matches accounts). If Fortnox not connected, use Personalkollen/POS with a note that accuracy may be lower.

**Current month prediction**: Start with Fortnox-trained baseline, then adjust using real-time POS pace. Formula:
```
forecast_remainder = (pos_revenue_today / days_elapsed) × days_remaining × correction_factor
correction_factor  = avg(fortnox_month / pos_month) over last 3 months
```

**Never mix sources in training**: Do not train a model on a mix of POS months and Fortnox months — the systematic differences will corrupt the model.

---

## 10. Implementation checklist for Claude Code

Before building any new integration:

- [ ] Check `businesses.revenue_source` — does this business already have a revenue source?
- [ ] If yes and adding a new POS: update `revenue_source`, add reconciliation, keep old data
- [ ] If yes and adding Fortnox: do NOT replace revenue data, add to `revenue_events` with `source='fortnox'`, run reconciliation
- [ ] Store raw JSON in `raw_data` column — never delete original data
- [ ] Add `source` and `source_id` to every event — `UNIQUE(source, source_id)` prevents duplicates
- [ ] Check `UNIQUE(source, source_id)` constraint handles re-syncs cleanly (upsert not insert)

Before building any dashboard or analytics query:

- [ ] Read `businesses.revenue_source` first
- [ ] Never `SUM()` across multiple sources
- [ ] For current month: query the live source
- [ ] For past months: query Fortnox if connected, otherwise live source
- [ ] Show source label next to every revenue figure

Before building any AI assistant context:

- [ ] Pass `businesses.revenue_source` to Claude so it can explain where numbers come from
- [ ] Include reconciliation status in context if there are unresolved discrepancies
- [ ] When discrepancy exists: tell Claude the difference and the likely cause

---

## 11. Fortnox-specific notes

**Authentication**: OAuth2. Tokens stored encrypted in `integrations` table. Auto-refresh before expiry.

**Rate limit**: 25 requests per 5 seconds per access token. Use a queue with backoff.

**Sync strategy**: 
- Initial backfill: `fromdate = today - 2 years`
- Daily sync: use `lastmodified = yesterday` (much faster than full re-fetch)

**Key endpoints for CommandCenter**:
- `/3/invoices` — customer invoices (revenue)
- `/3/supplierinvoices` — supplier costs (COGS, fixed costs)
- `/3/salarytransactions` — payroll (final labour cost)
- `/3/employees` — wage rates (needed for labour cost calculation)
- `/api/warehouse/status-v1/stockbalance` — stock levels

**Do not fetch** invoice PDFs unless a customer explicitly requests one. Store JSON only.

**VAT handling**: Fortnox amounts include VAT by default. Always store and display ex-VAT for P&L. Swedish standard rates: 25% (food service), 12% (food takeaway), 6% (rarely applies).

---

## 12. What to tell customers about data sources

When a customer asks why numbers differ between sources, the AI assistant should explain:

> "We show data from [source] for this period. Your POS gives us real-time numbers including tips and cash — these match what your staff see at the end of each night. Fortnox shows your invoiced revenue, which excludes tips and may be a day or two behind. For your monthly accounts and tax reporting, use the Fortnox figure. For day-to-day management, the POS number is more useful."

---

*This file is the data architecture reference for CommandCenter. Update it whenever a new integration is added or a reconciliation rule changes.*
*Companion files: CLAUDE.md · ROADMAP.md · MIGRATIONS.md*

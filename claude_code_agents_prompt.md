# Claude Code — AI Agents Build Spec

Read these files completely before writing any code:
- CLAUDE.md
- ROADMAP.md
- SAAS_MANIFEST.md
- MIGRATIONS.md

These agents run as background cron jobs. They do not require user interaction.
They are the features that make customers stay subscribed month after month.

---

## Build rules (from CLAUDE.md — apply to every file you touch)

- `'use client'` must be line 1, `// @ts-nocheck` line 2 on all page files
- `useState([])` → `useState<any[]>([])`
- `useState(null)` → `useState<any>(null)`
- No `.catch()` chaining on Supabase — use `try/catch`
- `export const maxDuration = 60` on all cron routes (they may run longer than default)
- Never call external APIs from page routes — only from cron/sync routes
- All cron routes must check: `req.headers.get('authorization') !== 'Bearer ' + process.env.CRON_SECRET`

---


---

## Model routing — critical cost rule

**Agents use Haiku 4.5. The interactive AI assistant uses Sonnet 4.6.**

This is not optional — it reduces agent AI costs by 70%.

```typescript
// lib/ai/models.ts — import this everywhere
export const AI_MODELS = {
  // Interactive assistant — customer is waiting, quality matters
  ASSISTANT: 'claude-haiku-4-5-20251001',   // was claude-sonnet-4-6 but haiku is fine for agents

  // Background agents — simple generation, no user waiting
  AGENT: 'claude-haiku-4-5-20251001',       // $1/$5 per 1M tokens vs $3/$15 for Sonnet

  // Complex analysis only (scheduling optimisation, multi-step reasoning)
  ANALYSIS: 'claude-sonnet-4-6',            // Only when Haiku genuinely not good enough
}

// Cost comparison per 1,000 agent runs (avg 500 input + 150 output tokens each):
// Haiku 4.5:   $0.50 input + $0.75 output = $1.25 total
// Sonnet 4.6:  $1.50 input + $2.25 output = $3.75 total
// Saving: 67% per 1,000 runs
```

In every agent route, use the model like this:
```typescript
import { AI_MODELS } from '@/lib/ai/models'

const response = await anthropic.messages.create({
  model: AI_MODELS.AGENT,  // always reference the constant, never hardcode
  max_tokens: 300,         // agents need short outputs — cap this tightly
  messages: [{ role: 'user', content: prompt }],
})
```

### When each model is appropriate

| Task | Model | Why |
|------|-------|-----|
| 1-sentence anomaly explanation | Haiku 4.5 | Simple factual statement |
| Monday briefing paragraph | Haiku 4.5 | Short structured summary |
| Onboarding welcome message | Haiku 4.5 | Template-like, warm tone |
| Supplier price alert | Haiku 4.5 | One sentence with numbers |
| Scheduling recommendations | Sonnet 4.6 | Multi-step analysis of patterns |
| Interactive AI assistant | Sonnet 4.6 | Customer waiting, complex queries |

### Create this file before building any agent

`lib/ai/models.ts`:
```typescript
// Single source of truth for AI model selection
// Always use these constants — never hardcode model strings

export const AI_MODELS = {
  AGENT:    'claude-haiku-4-5-20251001',  // Background agents: cheap, fast, good enough
  ANALYSIS: 'claude-sonnet-4-6',          // Complex multi-step reasoning only
  ASSISTANT:'claude-sonnet-4-6',          // Interactive assistant: quality matters
} as const

// Max tokens per use case — cap tightly to control costs
export const MAX_TOKENS = {
  AGENT_EXPLANATION: 150,   // One sentence anomaly/alert explanation
  AGENT_SUMMARY: 300,       // Weekly briefing paragraph
  AGENT_RECOMMENDATION: 400,// Scheduling/supplier recommendations
  ASSISTANT: 2000,          // Interactive queries — needs room to explain
} as const
```

---

## SQL to run in Supabase BEFORE building (run in order)

```sql
-- 1. Briefings table (Monday morning briefing agent)
CREATE TABLE IF NOT EXISTS briefings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id  UUID REFERENCES businesses(id) ON DELETE CASCADE,
  week_start   DATE NOT NULL,
  content      TEXT NOT NULL,
  key_metrics  JSONB,
  created_at   TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, week_start)
);
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "briefings_select_own" ON briefings
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

-- 2. Forecast calibration table
CREATE TABLE IF NOT EXISTS forecast_calibration (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id          UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at   TIMESTAMPTZ DEFAULT now(),
  accuracy_pct    NUMERIC,
  bias_factor     NUMERIC DEFAULT 1.0,
  dow_factors     JSONB,
  notes           TEXT,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;

-- 3. Onboarding success log (track which businesses got the success email)
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

---

## Agent 1 — Anomaly detection (COMPLETE THE EXISTING SKELETON)

**File**: `app/api/cron/anomaly-check/route.ts`
**Schedule**: Already in vercel.json at 06:00 UTC daily
**Status**: Skeleton exists — needs the actual logic

### What to build

The route already exists. Replace the placeholder logic with:

**Step 1 — Load data per business (last 35 days)**
```typescript
// For each connected business, load:
const { data: staffLogs } = await db
  .from('staff_logs')
  .select('shift_date, cost_actual, hours_worked, staff_group, ob_supplement_kr')
  .eq('business_id', biz.id)
  .gte('shift_date', thirtyFiveDaysAgo)

const { data: revenueLogs } = await db
  .from('revenue_logs')
  .select('revenue_date, revenue, covers')
  .eq('business_id', biz.id)
  .gte('revenue_date', thirtyFiveDaysAgo)
```

**Step 2 — Calculate rolling 4-week baselines (pure maths, no Claude)**
```typescript
// Group by week, calculate averages
// baseline = average of weeks -5 to -2 (exclude this week and last week)
// this_week = most recent 7 days
```

**Step 3 — Detect anomalies using these thresholds**
```typescript
const THRESHOLDS = {
  revenue_drop_pct: -15,        // revenue down 15%+ vs baseline
  staff_cost_spike_pp: 8,       // staff cost % up 8pp vs baseline  
  food_cost_spike_pp: 5,        // food cost % up 5pp vs baseline
  dept_cost_spike_pct: 25,      // any dept cost up 25%+ week on week
  ob_supplement_spike_pct: 40,  // OB supplement up 40%+ (unplanned overtime)
}
```

**Step 4 — For each anomaly found, call Claude for a 1-sentence explanation**
```typescript
const prompt = `You are analysing restaurant financial data. Write ONE sentence explaining this anomaly to a restaurant owner. Be specific, practical, and suggest a possible cause.

Anomaly: ${anomaly.type}
Business metric: ${anomaly.metric_value} vs expected ${anomaly.expected_value} (${anomaly.deviation_pct}% deviation)
Department: ${anomaly.department ?? 'all departments'}
Week: ${anomaly.week}

Write only the explanation sentence. No preamble.`
```

**Step 5 — Upsert to anomaly_alerts**
```typescript
await db.from('anomaly_alerts').upsert({
  org_id, business_id,
  alert_type: anomaly.type,   // 'revenue_drop' | 'staff_cost_spike' | 'food_cost_spike' | 'dept_spike' | 'ob_spike'
  severity: anomaly.severity, // 'low' | 'medium' | 'high' | 'critical'
  title: anomaly.title,       // e.g. "Staff costs 23% above average"
  description: claudeExplanation,
  metric_value: anomaly.metric_value,
  expected_value: anomaly.expected_value,
  deviation_pct: anomaly.deviation_pct,
  period_date: anomaly.week_start,
  is_read: false,
  is_dismissed: false,
}, { onConflict: 'business_id,alert_type,period_date' })
```

**Step 6 — Send email for critical severity only**
Use Resend to send a plain email to the org owner's email. Subject: "Alert: [business name] — [alert title]"

### Severity mapping
- `low`: deviation 10-20%, informational
- `medium`: deviation 20-35%, worth checking
- `high`: deviation 35-50%, act soon  
- `critical`: deviation 50%+, act now

### Cost estimate
~$0.002 per business per night (Claude only called when anomalies found).
At 50 businesses: ~$0.10/night = ~$3/month. Negligible.

---

## Agent 2 — Onboarding success agent (NEW)

**File**: `app/api/agents/onboarding-success/route.ts`
**Trigger**: Called from `lib/sync/engine.ts` after first successful backfill (when `shifts > 0` and this is the first sync for the business)

### What to build

**In `lib/sync/engine.ts`**, after a successful sync, add:
```typescript
// After the upsert completes
if (result.shifts > 0) {
  const { data: integration } = await db
    .from('integrations')
    .select('onboarding_email_sent')
    .eq('id', integrationId)
    .single()
  
  if (!integration?.onboarding_email_sent) {
    // Fire onboarding success agent (non-blocking)
    fetch(`${baseUrl}/api/agents/onboarding-success`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: orgId, business_id: businessId, integration_id: integrationId, result }),
    }).catch(console.error)
  }
}
```

**The agent route** (`app/api/agents/onboarding-success/route.ts`):

1. Verify the data looks correct:
   - `shifts > 0` ✓
   - `staff_count > 0` ✓
   - Date range looks reasonable (not just 1 day)
   - If anything looks wrong: email paul@laweka.com with details, do NOT email customer

2. Gather a summary:
```typescript
const { data: summary } = await db
  .from('staff_logs')
  .select('staff_name, staff_group, shift_date')
  .eq('business_id', businessId)
  .order('shift_date', { ascending: true })
  .limit(1)
// Get earliest date, count by department, total shifts
```

3. Call Claude to write the welcome message:
```typescript
const prompt = `Write a friendly 2-sentence welcome message for a restaurant owner whose data has just connected to CommandCenter.

Data imported:
- ${totalShifts} shifts across ${staffCount} staff members
- Date range: ${earliestDate} to today
- Departments: ${departments.join(', ')}
- Most active department: ${topDepartment} (${topDeptPct}% of hours)

Tone: warm, brief, tell them what they can now explore. End with one suggested first action.`
```

4. Send welcome email via Resend:
   - Subject: "Your data is live — here's what we found"
   - Body: Claude's message + a clean summary table + 3 deep links (Staff overview, Department breakdown, This month)

5. Mark integration as onboarding email sent:
```typescript
await db.from('integrations')
  .update({ onboarding_email_sent: true })
  .eq('id', integrationId)
```

### Cost estimate
~$0.01 per new customer. Fires once. Negligible.

---

## Agent 3 — Monday morning briefing (NEW)

**File**: `app/api/cron/monday-briefing/route.ts`
**Schedule**: Add to vercel.json: `{ "path": "/api/cron/monday-briefing", "schedule": "0 5 * * 1" }` (05:00 UTC = 07:00 Stockholm)
**Plans**: Pro and Group only (check org plan before sending)

### What to build

**For each Pro/Group org, for each connected business:**

1. Load last 7 days data:
```typescript
const weekStart = getLastMonday() // Previous Monday
const weekEnd   = addDays(weekStart, 6)

const [revenue, staff, tracker, alerts] = await Promise.all([
  db.from('revenue_logs').select('*').eq('business_id', biz.id).gte('revenue_date', weekStart).lte('revenue_date', weekEnd),
  db.from('staff_logs').select('cost_actual, hours_worked, ob_supplement_kr').eq('business_id', biz.id).gte('shift_date', weekStart).lte('shift_date', weekEnd),
  db.from('tracker_data').select('*').eq('business_id', biz.id).eq('period_year', year).eq('period_month', month),
  db.from('anomaly_alerts').select('title, severity').eq('business_id', biz.id).gte('created_at', weekStart).eq('is_dismissed', false),
])
```

2. Load comparison data (same week last year, previous week, budgets):
```typescript
// Same week last year
const sameWeekLastYear = await db.from('revenue_logs')
  .select('revenue, covers')
  .eq('business_id', biz.id)
  .gte('revenue_date', subYears(weekStart, 1))
  .lte('revenue_date', subYears(weekEnd, 1))
```

3. Build metrics object:
```typescript
const metrics = {
  total_revenue: sum(revenue, 'revenue'),
  total_covers: sum(revenue, 'covers'),
  total_staff_cost: sum(staff, 'cost_actual'),
  total_ob: sum(staff, 'ob_supplement_kr'),
  revenue_vs_lyw: pctChange(metrics.total_revenue, lastYearRevenue),
  revenue_vs_prev_week: pctChange(metrics.total_revenue, prevWeekRevenue),
  staff_cost_pct: metrics.total_staff_cost / metrics.total_revenue * 100,
  busiest_day: findBusiestDay(revenue),
  alerts_count: alerts.length,
  alerts_summary: alerts.map(a => a.title).join(', '),
}
```

4. Call Claude:
```typescript
const prompt = `You are writing a Monday morning briefing for the owner of ${biz.name}, a Swedish restaurant.
Write 3-4 sentences summarising last week. Be direct and specific with numbers.
Use SEK for currency. Mention the most interesting positive and the most important thing to watch.
Do not start with "Last week" — vary the opening.

Last week's data:
${JSON.stringify(metrics, null, 2)}

Write only the briefing paragraph. No subject line, no sign-off.`
```

5. Save to briefings table:
```typescript
await db.from('briefings').upsert({
  org_id, business_id,
  week_start: weekStart,
  content: claudeResponse,
  key_metrics: metrics,
})
```

6. Send email via Resend:
```
Subject: "[Business name] — week of [date]"

[Claude's paragraph]

---
Revenue:     42,300 kr  (+12% vs last year)
Covers:      847         (+8%)
Staff cost:  31%         (budget: 33%)
Best day:    Saturday    (187 covers)

[Alert if any]: ⚠ Food cost elevated Thursday

View full details → [link to /dashboard]
```

7. Surface in-app: the `/alerts` or a new `/briefings` page shows past briefings so customers can read them inside the app.

### Cost estimate
One Claude call per business per week.
~$0.003 per briefing × 50 businesses × 4 weeks = ~$0.60/month. Negligible.

---

## Agent 4 — Forecast calibration (NEW)

**File**: `app/api/cron/forecast-calibration/route.ts`
**Schedule**: `{ "path": "/api/cron/forecast-calibration", "schedule": "0 4 1 * *" }` (04:00 UTC on 1st of each month)
**No Claude needed** — pure arithmetic

### What to build

For each business with at least 3 months of data:

1. Load last month's forecasts vs actuals:
```typescript
const lastMonth = subMonths(now, 1)
const forecasts = await db.from('forecasts')
  .select('period_year, period_month, revenue_forecast, staff_cost_forecast')
  .eq('business_id', biz.id)
  .eq('period_year', lastMonth.getFullYear())
  .eq('period_month', lastMonth.getMonth() + 1)

const actuals = await db.from('tracker_data')
  .select('revenue, staff_cost')
  .eq('business_id', biz.id)
  .eq('period_year', lastMonth.getFullYear())
  .eq('period_month', lastMonth.getMonth() + 1)
```

2. Calculate accuracy and bias:
```typescript
const revenueBias = actuals.revenue / forecasts.revenue_forecast // 1.0 = perfect, 1.1 = we under-forecast by 10%
const accuracyPct = 100 - Math.abs((actuals.revenue - forecasts.revenue_forecast) / actuals.revenue * 100)

// Build day-of-week factors from 90 days of revenue_logs vs week-level forecasts
```

3. Upsert to forecast_calibration:
```typescript
await db.from('forecast_calibration').upsert({
  business_id, org_id,
  calibrated_at: now(),
  accuracy_pct: accuracyPct,
  bias_factor: rollingBias, // 3-month rolling average of bias
  dow_factors: dowFactors,  // { 0: 0.85, 1: 0.90, 2: 0.95, 3: 1.0, 4: 1.1, 5: 1.3, 6: 1.2 }
})
```

4. Update the forecast page to read calibration:
   - Show "Forecast accuracy: 94%" badge on `/forecast` page
   - Apply `bias_factor` and `dow_factors` when generating next month's predictions

### Cost estimate
$0 — no Claude. Pure DB aggregation.

---

## Agent 5 — Supplier price creep (build after Fortnox connected)

**File**: `app/api/cron/supplier-check/route.ts`
**Schedule**: `{ "path": "/api/cron/supplier-check", "schedule": "0 6 1 * *" }` (1st of each month)
**Requires**: Fortnox connected, invoices table populated

### What to build

For each business with Fortnox connected and 4+ months of invoice data:

1. Group invoices by vendor, calculate 3-month vs 12-month average:
```typescript
const { data: invoices } = await db
  .from('invoices')
  .select('vendor_name, amount, invoice_date, category')
  .eq('business_id', biz.id)
  .gte('invoice_date', twelveMonthsAgo)

// Group by vendor_name
// avg_12m = average invoice amount over 12 months
// avg_3m  = average invoice amount over last 3 months
// spike = (avg_3m - avg_12m) / avg_12m > 0.10
```

2. For vendors with >10% price creep, call Claude:
```typescript
const prompt = `Write one sentence alerting a restaurant owner that a supplier's prices have risen.
Supplier: ${vendor}
Average 12 months ago: ${avg12m} kr
Average last 3 months: ${avg3m} kr  
Increase: ${increase}%
Monthly extra cost: ${extraPerMonth} kr

Be specific with the numbers. Suggest they check or renegotiate.`
```

3. Create anomaly alert for each flagged supplier:
```typescript
await db.from('anomaly_alerts').upsert({
  alert_type: 'supplier_price_creep',
  severity: increase > 20 ? 'high' : 'medium',
  title: `${vendor} prices up ${Math.round(increase)}%`,
  description: claudeResponse,
  ...
})
```

### Cost estimate
~$0.02 per business per month. Negligible.

---

## Agent 6 — Scheduling optimisation (build after 6 months live data)

**File**: `app/api/cron/scheduling-analysis/route.ts`
**Schedule**: `{ "path": "/api/cron/scheduling-analysis", "schedule": "0 6 * * 1" }` (weekly, Monday)
**Plans**: Group only
**Requires**: 6 months of staff_logs data

### What to build

For each Group-plan business with 6+ months of shift data:

1. Load 6 months of actual vs scheduled hours by department and day of week:
```typescript
const { data: shifts } = await db
  .from('staff_logs')
  .select('shift_date, staff_group, hours_worked, cost_actual, real_start, real_stop')
  .eq('business_id', biz.id)
  .gte('shift_date', sixMonthsAgo)
```

2. Calculate patterns:
```typescript
// Group by: staff_group (department) × day_of_week
// For each combination:
//   avg_hours_worked = mean(hours_worked)
//   std_hours = stddev(hours_worked)  
//   trend = is avg_hours consistently < 70% of what's scheduled?
```

3. Identify optimisation opportunities:
```typescript
// Overstaffed pattern: scheduled > actual by >25% consistently
// Understaffed pattern: actual > scheduled by >20% consistently (overtime signal)
// Calculate monthly cost impact of each pattern
```

4. Call Claude with findings:
```typescript
const prompt = `You are advising a restaurant group owner on scheduling efficiency.
Based on 6 months of shift data, here are the patterns found:

${patterns.map(p => `- ${p.department} on ${p.day}: scheduled ${p.scheduled_avg}h, worked ${p.actual_avg}h (${p.variance_pct}% ${p.direction})`).join('\n')}

Write 2-3 specific, actionable recommendations. Include estimated monthly savings in SEK.
Use the actual numbers provided. Be direct and practical.`
```

5. Store as anomaly alerts with type `scheduling_opportunity`:
```typescript
await db.from('anomaly_alerts').upsert({
  alert_type: 'scheduling_opportunity',
  severity: 'low',
  title: `Scheduling optimisation: save ~${estimatedSaving} kr/month`,
  description: claudeResponse,
  ...
})
```

---

## vercel.json — add these cron entries

```json
{
  "path": "/api/cron/monday-briefing",
  "schedule": "0 5 * * 1"
},
{
  "path": "/api/cron/forecast-calibration", 
  "schedule": "0 4 1 * *"
},
{
  "path": "/api/cron/supplier-check",
  "schedule": "0 6 1 * *"
},
{
  "path": "/api/cron/scheduling-analysis",
  "schedule": "0 6 * * 1"
}
```

---

## Build order (work through in this sequence)

1. **Anomaly detection** — complete existing skeleton (3 hrs)
2. **Onboarding success** — in progress, route + trigger built (2 hrs)  
3. **Monday briefing** — new cron + email (4 hrs, needs Resend working)
4. **Forecast calibration** — new cron, no Claude needed (4 hrs)
5. **Supplier check** — build after Fortnox connected (3 hrs)
6. **Scheduling optimisation** — build after 6 months live data (6 hrs)

---

## After each agent is built

- Deploy: `git add . && git commit -m "Agent: [name]" && vercel --prod`
- Test by calling the cron route manually: `curl -X POST https://comandcenter.se/api/cron/[route] -H "Authorization: Bearer $CRON_SECRET"`
- Check Supabase for written records
- Check email inbox for any sent emails

---

## Total cost at 50 customers (all agents running)

| Agent | Monthly API cost |
|-------|-----------------|
| Anomaly detection | ~$3.00 |
| Monday briefing | ~$0.60 |
| Onboarding success | ~$0.50 (new customers only) |
| Forecast calibration | $0.00 |
| Supplier check | ~$1.00 |
| Scheduling optimisation | ~$10.00 (Group plan only, maybe 10 customers) |
| **Total** | **~$15/month** |

At 50 customers paying 799 kr/month, this is ~160 kr/month in agent costs.
Revenue from those customers: ~39,950 kr/month.
Agent cost as % of revenue: 0.4%.

These agents justify the Pro plan price difference vs Starter on their own.

---

## When all agents are built

Remind me to:
1. Add `CRON_SECRET` env var in Vercel dashboard
2. Verify Resend domain so emails actually send
3. Run the SQL migrations listed at the top of this file
4. Update `commandcenter_improvement_plan.html` and `ROADMAP.md`

// lib/reports/margin-report.ts
//
// Prototype: build a "margin report" spec for one business — real numbers
// from tracker_data + an AI-written executive summary and recommendations.
//
// Pattern (see the brainstorm): the LLM produces the NARRATIVE/SPEC, code
// renders the file. Every figure here is pulled from persisted financials;
// the AI only writes prose grounded in those numbers (so a downloadable doc
// the owner might forward can't contain a fabricated figure).

import { AI_MODELS }    from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { SCOPE_NOTE }   from '@/lib/ai/scope'

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface MarginMonth {
  year:       number
  month:      number
  label:      string   // "May 2026"
  revenue:    number
  food_cost:  number
  staff_cost: number
  other_cost: number
  net_profit: number
  margin_pct: number   // net margin %
  food_pct:   number   // food cost as % of revenue
  labour_pct: number   // staff cost as % of revenue
  is_anomaly: boolean  // clear data error (write-off / uncaptured labour) — excluded from headline averages
}

// A month is a DATA ERROR (not a genuinely bad trading month) when the
// figures are operationally impossible: labour not captured, a food-cost
// write-off, or an absurd negative margin. We exclude these from the
// headline KPIs so they don't skew the average, but still show them in the
// table flagged for review. We deliberately KEEP real-but-bad months
// (e.g. high labour % on a low-revenue month) — those are signal, not noise.
function isDataAnomaly(m: { revenue: number; food_pct: number; labour_pct: number; margin_pct: number }): boolean {
  return (m.labour_pct === 0 && m.revenue > 0)   // labour not posted to this period
    || m.food_pct > 80                            // write-off / misallocation
    || m.margin_pct < -150                        // not a real trading result
}

export interface MarginReportSpec {
  business_name:     string
  period_label:      string
  generated_at:      string
  months:            MarginMonth[]
  latest:            MarginMonth | null
  averages:          { margin_pct: number; food_pct: number; labour_pct: number; revenue: number }
  anomaly_count:     number   // months excluded from the averages (flagged in the table)
  executive_summary: string
  recommendations:   Array<{ title: string; detail: string }>
  ai_used:           boolean
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0
}

/** Last 12 closed (non-provisional) months of P&L, chronological. */
export async function loadMarginMonths(db: any, businessId: string): Promise<MarginMonth[]> {
  const { data } = await db
    .from('tracker_data')
    .select('period_year, period_month, revenue, food_cost, staff_cost, other_cost, net_profit, margin_pct')
    .eq('business_id', businessId)
    .or('is_provisional.is.null,is_provisional.eq.false')   // closed months only
    .order('period_year',  { ascending: false })
    .order('period_month', { ascending: false })
    .limit(12)

  const rows = (data ?? [])
    .map((r: any) => {
      const revenue    = Number(r.revenue ?? 0)
      const food_cost  = Number(r.food_cost ?? 0)
      const staff_cost = Number(r.staff_cost ?? 0)
      return {
        year:       Number(r.period_year),
        month:      Number(r.period_month),
        label:      `${MONTH_NAMES[Number(r.period_month)] ?? '?'} ${r.period_year}`,
        revenue,
        food_cost,
        staff_cost,
        other_cost: Number(r.other_cost ?? 0),
        net_profit: Number(r.net_profit ?? 0),
        margin_pct: Number(r.margin_pct ?? 0),
        food_pct:   pct(food_cost, revenue),
        labour_pct: pct(staff_cost, revenue),
        is_anomaly: false,
      }
    })
    .map((m: MarginMonth) => ({ ...m, is_anomaly: isDataAnomaly(m) }))
    .filter((m: MarginMonth) => m.revenue > 0)        // skip empty months
    .sort((a: MarginMonth, b: MarginMonth) => a.year - b.year || a.month - b.month)

  return rows
}

/** Build the full report spec, including the AI narrative (soft-fails to a
 *  deterministic templated summary if the model is unavailable/over quota). */
export async function buildMarginReportSpec(
  db: any,
  businessId: string,
  businessName: string,
): Promise<MarginReportSpec> {
  const months = await loadMarginMonths(db, businessId)
  const latest = months.length ? months[months.length - 1] : null

  // Headline averages over CLEAN months only (exclude data errors), so one
  // write-off / uncaptured-labour month can't make the whole report read as
  // a -55% margin business.
  const clean = months.filter(m => m.revenue > 0 && !m.is_anomaly)
  const anomaly_count = months.filter(m => m.is_anomaly).length
  const base = clean.length ? clean : months.filter(m => m.revenue > 0)  // fall back if everything's flagged
  const avg = (sel: (m: MarginMonth) => number) =>
    base.length ? Math.round((base.reduce((s, m) => s + sel(m), 0) / base.length) * 10) / 10 : 0
  const averages = {
    margin_pct: avg(m => m.margin_pct),
    food_pct:   avg(m => m.food_pct),
    labour_pct: avg(m => m.labour_pct),
    revenue:    base.length ? Math.round(base.reduce((s, m) => s + m.revenue, 0) / base.length) : 0,
  }

  const period_label = months.length
    ? `${months[0].label} – ${months[months.length - 1].label}`
    : 'No closed periods yet'

  let executive_summary = ''
  let recommendations: Array<{ title: string; detail: string }> = []
  let ai_used = false

  if (months.length > 0) {
    const ai = await generateNarrative(months, averages, latest, businessName)
    if (ai) {
      executive_summary = ai.executive_summary
      recommendations   = ai.recommendations
      ai_used = true
    }
  }

  // Deterministic fallback so the PDF is never empty.
  if (!executive_summary) {
    executive_summary = months.length
      ? `Over ${months.length} closed months, ${businessName} averaged a ${averages.margin_pct}% net margin on ~${averages.revenue.toLocaleString('en-GB')} kr monthly revenue, with food at ${averages.food_pct}% and labour at ${averages.labour_pct}% of sales.`
      : `No closed-month financials are available yet for ${businessName}.`
  }
  if (recommendations.length === 0 && months.length) {
    recommendations = fallbackRecommendations(averages)
  }

  return {
    business_name: businessName,
    period_label,
    generated_at:  new Date().toISOString(),
    months,
    latest,
    averages,
    anomaly_count,
    executive_summary,
    recommendations,
    ai_used,
  }
}

function fallbackRecommendations(avg: { margin_pct: number; food_pct: number; labour_pct: number }) {
  const recs: Array<{ title: string; detail: string }> = []
  if (avg.food_pct > 32) {
    recs.push({ title: 'Bring food cost toward 28–32%', detail: `Food is running at ${avg.food_pct}% of sales, above the 28–32% target. Review supplier pricing, portioning, and waste on the highest-spend items.` })
  }
  if (avg.labour_pct > 30) {
    recs.push({ title: 'Tighten labour scheduling', detail: `Labour is ${avg.labour_pct}% of sales. Trim hours on the lowest-revenue dayparts to protect margin without adding cover where demand isn't proven.` })
  }
  recs.push({ title: 'Protect the strongest months', detail: 'Identify what drove your best-margin months and repeat those mix/pricing decisions.' })
  return recs
}

async function generateNarrative(
  months: MarginMonth[],
  averages: { margin_pct: number; food_pct: number; labour_pct: number; revenue: number },
  latest: MarginMonth | null,
  businessName: string,
): Promise<{ executive_summary: string; recommendations: Array<{ title: string; detail: string }> } | null> {
  const table = months.map(m =>
    `${m.label}: revenue ${Math.round(m.revenue)} kr, food ${m.food_pct}%, labour ${m.labour_pct}%, net margin ${m.margin_pct}%${m.is_anomaly ? '  [DATA ANOMALY — flag for review, do not treat as real trading]' : ''}`
  ).join('\n')

  const SYSTEM = `You are a restaurant-group CFO advisor writing a short margin report for an owner. ${SCOPE_NOTE}

Rules:
- Ground EVERY claim in the figures provided. Never invent a number.
- For labour, only recommend reducing/optimising hours, never speculatively adding cover.
- Recommendations must be concrete and actionable for a restaurant operator.
- Benchmarks: food cost target 28–32% of sales; healthy net margin for a restaurant is ~10–15%.

Return JSON only:
{
  "executive_summary": "2-3 sentences on the margin trend and what's driving it",
  "recommendations": [ { "title": "short imperative", "detail": "1-2 sentences, specific" } ]  // 3-5 items
}`

  const user = `Business: ${businessName}
Averages over the period: net margin ${averages.margin_pct}%, food ${averages.food_pct}%, labour ${averages.labour_pct}%, ~${averages.revenue} kr/month revenue.
${latest ? `Most recent month (${latest.label}): margin ${latest.margin_pct}%, food ${latest.food_pct}%, labour ${latest.labour_pct}%.` : ''}

Monthly figures:
${table}

Write the report. JSON only.`

  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,   // Sonnet — owner-facing narrative quality matters
      max_tokens: 2200,                  // headroom so the JSON (summary + recs) isn't truncated mid-array
      system:     SYSTEM,
      messages:   [{ role: 'user', content: user }],
    },
  })
  if (!result.ok) return null
  try {
    const text = result.json?.content?.[0]?.text ?? ''
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const recs = Array.isArray(parsed.recommendations)
      ? parsed.recommendations
          .filter((r: any) => r?.title)
          .map((r: any) => ({ title: String(r.title).slice(0, 120), detail: String(r.detail ?? '').slice(0, 400) }))
      : []
    if (!parsed.executive_summary) return null
    return { executive_summary: String(parsed.executive_summary).slice(0, 800), recommendations: recs }
  } catch {
    return null
  }
}

// scripts/reaggregate-rosali.ts
// Rebuild Rosali's monthly_metrics and forecasts from now-clean tracker_data.

import { createClient } from '@supabase/supabase-js'
import { aggregateMetrics } from '../lib/sync/aggregate'
import { monthlyForecast } from '../lib/forecast/monthly'

const ROSALI_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const ROSALI_BUSINESS_ID = '97187ef3-b816-4c41-9230-7551430784a7'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE env missing')
  const db = createClient(url, key)

  // ── Re-aggregate Rosali for 2025-2026 ────────────────────────────────
  console.log('[re-agg] Rebuilding monthly_metrics for Rosali 2025-2026...')
  for (const year of [2025, 2026]) {
    const t0 = Date.now()
    const res = await aggregateMetrics(ROSALI_ORG_ID, ROSALI_BUSINESS_ID, `${year}-01-01`, `${year}-12-31`)
    console.log(`  ${year}: ${JSON.stringify(res)} (${Math.round((Date.now()-t0))}ms)`)
  }
  console.log()

  // ── Show resulting monthly_metrics for the affected months ───────────
  console.log('[re-agg] Resulting monthly_metrics for Rosali 2026-02 through 2026-05:')
  const { data: mm } = await db.from('monthly_metrics')
    .select('year, month, revenue, staff_cost, food_cost, net_profit')
    .eq('business_id', ROSALI_BUSINESS_ID)
    .eq('year', 2026)
    .gte('month', 2)
    .lte('month', 5)
    .order('month')
  for (const m of (mm ?? [])) {
    console.log(`  ${m.year}-${String(m.month).padStart(2,'0')}  rev=${m.revenue}  staff=${m.staff_cost}  food=${m.food_cost}  net=${m.net_profit}`)
  }
  console.log()

  // ── Re-run monthly forecasts for Rosali ──────────────────────────────
  console.log('[re-agg] Rebuilding Rosali\'s forecasts table...')
  const now  = new Date()
  const year = now.getFullYear()
  const months: Array<{ year: number; month: number }> = []
  for (let m = 1; m <= 12; m++) months.push({ year, month: m })
  for (let i = 1; i <= 3; i++) {
    const d = new Date(year, now.getMonth() + i, 1)
    if (d.getFullYear() > year) months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  let written = 0, errored = 0
  for (const { year: fYear, month: fMonth } of months) {
    try {
      const mf = await monthlyForecast(ROSALI_BUSINESS_ID, fYear, fMonth, { db, asOfDate: now })
      await db.from('forecasts').upsert({
        org_id: ROSALI_ORG_ID, business_id: ROSALI_BUSINESS_ID,
        period_year: fYear, period_month: fMonth,
        revenue_forecast: mf.revenue_forecast,
        staff_cost_forecast: mf.staff_cost_forecast,
        food_cost_forecast:  mf.food_cost_forecast,
        net_profit_forecast: mf.net_profit_forecast,
        margin_forecast:     mf.margin_forecast,
        confidence: mf.confidence, method: mf.method, based_on_months: mf.based_on_months,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'org_id,business_id,period_year,period_month' })
      written++
    } catch (e: any) {
      errored++
      console.error(`  ${fYear}-${fMonth}: ${e?.message}`)
    }
  }
  console.log(`  forecasts: ${written} written, ${errored} errored`)
  console.log('\n[re-agg] DONE.')
}

main().catch(e => { console.error(e); process.exit(1) })

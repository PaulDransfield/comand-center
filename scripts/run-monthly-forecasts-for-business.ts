// scripts/run-monthly-forecasts-for-business.ts
//
// Generic single-business monthly-forecasts runner. Called from
// rollout-v2-all-businesses.mjs (or directly for one-off runs).
//
// Args: <businessId> <orgId> [<name for log>]
//
// Same logic as run-vero-monthly-forecasts.ts, parameterised.

import { createClient } from '@supabase/supabase-js'
import { monthlyForecast } from '../lib/forecast/monthly'

const [businessId, orgId, name] = process.argv.slice(2)
if (!businessId || !orgId) {
  console.error('usage: tsx scripts/run-monthly-forecasts-for-business.ts <businessId> <orgId> [name]')
  process.exit(2)
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE env missing')
  const db = createClient(url, key)

  const now  = new Date()
  const year = now.getFullYear()
  const months: Array<{ year: number; month: number }> = []
  for (let m = 1; m <= 12; m++) months.push({ year, month: m })
  for (let i = 1; i <= 3; i++) {
    const d = new Date(year, now.getMonth() + i, 1)
    if (d.getFullYear() > year) months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }

  let written = 0, errored = 0
  const t0 = Date.now()

  for (const { year: fYear, month: fMonth } of months) {
    try {
      const mf = await monthlyForecast(businessId, fYear, fMonth, { db, asOfDate: now })
      await db.from('forecasts').upsert({
        org_id: orgId, business_id: businessId,
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
    } catch {
      errored++
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000)
  // Print summary as the LAST line so the orchestrator can grep it
  console.log(`${name ?? businessId}: ${written} written, ${errored} errored in ${elapsed}s`)
}

main().catch(e => { console.error(`fatal: ${e?.message ?? e}`); process.exit(1) })

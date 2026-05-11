// scripts/run-vero-monthly-forecasts.ts
//
// Populate Vero's `forecasts` table with consolidated_monthly_v1.0 rows
// for all 12 months of 2026 + 3 months of 2027. Runs immediately —
// don't wait for the next sync. Idempotent (upserts).
//
// Run: npx -y dotenv-cli -e .env.production.local -- npx tsx scripts/run-vero-monthly-forecasts.ts

import { createClient } from '@supabase/supabase-js'
import { monthlyForecast } from '../lib/forecast/monthly'

const VERO_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE env missing — load .env.production.local')
  const db = createClient(url, key)

  const now  = new Date()
  const year = now.getFullYear()
  const months: Array<{ year: number; month: number }> = []
  for (let m = 1; m <= 12; m++) months.push({ year, month: m })
  for (let i = 1; i <= 3; i++) {
    const d = new Date(year, now.getMonth() + i, 1)
    if (d.getFullYear() > year) months.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }

  console.log(`[v2-monthly] Vero — ${months.length} months to forecast`)
  console.log()

  let written = 0
  let errored = 0
  const startedAt = Date.now()

  for (const { year: fYear, month: fMonth } of months) {
    try {
      const t0 = Date.now()
      const mf = await monthlyForecast(VERO_BUSINESS_ID, fYear, fMonth, { db, asOfDate: now })
      const t1 = Date.now()

      await db.from('forecasts').upsert({
        org_id:              VERO_ORG_ID,
        business_id:         VERO_BUSINESS_ID,
        period_year:         fYear,
        period_month:        fMonth,
        revenue_forecast:    mf.revenue_forecast,
        staff_cost_forecast: mf.staff_cost_forecast,
        food_cost_forecast:  mf.food_cost_forecast,
        net_profit_forecast: mf.net_profit_forecast,
        margin_forecast:     mf.margin_forecast,
        confidence:          mf.confidence,
        method:              mf.method,
        based_on_months:     mf.based_on_months,
        updated_at:          new Date().toISOString(),
      }, { onConflict: 'org_id,business_id,period_year,period_month' })

      written++
      const path = mf.method.split(':')[1] ?? '?'
      console.log(`  ${fYear}-${String(fMonth).padStart(2,'0')}  ${path.padEnd(22)}  rev=${mf.revenue_forecast.toLocaleString('sv-SE').padStart(12)} staff=${mf.staff_cost_forecast.toLocaleString('sv-SE').padStart(10)} food=${mf.food_cost_forecast.toLocaleString('sv-SE').padStart(9)} net=${mf.net_profit_forecast.toLocaleString('sv-SE').padStart(11)} margin=${mf.margin_forecast.toString().padStart(5)}%  conf=${mf.confidence}  (${t1-t0}ms)`)
    } catch (e: any) {
      errored++
      console.error(`  ${fYear}-${fMonth}: ${e?.message ?? e}`)
    }
  }

  console.log()
  console.log(`[v2-monthly] DONE in ${Math.round((Date.now()-startedAt)/1000)}s  written=${written} errored=${errored}`)
}

main().catch(e => { console.error(e); process.exit(1) })

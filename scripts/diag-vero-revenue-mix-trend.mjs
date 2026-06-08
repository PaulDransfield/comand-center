// scripts/diag-vero-revenue-mix-trend.mjs
//
// Does Vero's revenue mix (dine-in / takeaway / alcohol) shift across
// seasons? If yes, the model should forecast the three streams
// separately and sum.

import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

const { data } = await db
  .from('tracker_data')
  .select('period_year, period_month, revenue, dine_in_revenue, takeaway_revenue, alcohol_revenue, is_provisional')
  .eq('business_id', VERO)
  .or('is_provisional.is.null,is_provisional.eq.false')
  .gte('period_year', 2025)
  .order('period_year').order('period_month')

console.log()
console.log('Vero revenue-mix trend')
console.log('Period   total      dine_in    %dine  takeaway   %takeaway alcohol    %alc')
for (const r of data ?? []) {
  const ym = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`
  const total = Number(r.revenue ?? 0)
  const di    = Number(r.dine_in_revenue ?? 0)
  const ta    = Number(r.takeaway_revenue ?? 0)
  const al    = Number(r.alcohol_revenue ?? 0)
  if (total === 0) continue
  const pct = (n) => total > 0 ? (n / total * 100).toFixed(1).padStart(5) : '   —'
  console.log(`${ym}  ${Math.round(total).toLocaleString('sv-SE').padStart(8)}   ${Math.round(di).toLocaleString('sv-SE').padStart(8)}  ${pct(di)}%   ${Math.round(ta).toLocaleString('sv-SE').padStart(8)}  ${pct(ta)}%    ${Math.round(al).toLocaleString('sv-SE').padStart(8)}  ${pct(al)}%`)
}

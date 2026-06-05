// Quick schema verification for operations.ts tools.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')]
  })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const TABLES = [
  { t: 'monthly_metrics',  cols: 'year, month, revenue, covers, food_revenue, bev_revenue, staff_cost, food_cost' },
  { t: 'daily_metrics',    cols: 'date, revenue, covers, rev_per_cover, food_revenue, bev_revenue, dine_in, takeaway, staff_cost, hours_worked, shifts' },
  { t: 'tracker_data',     cols: 'period_year, period_month, revenue, food_cost, staff_cost, other_cost, total_cost, gross_profit, net_profit, margin_pct, source, is_provisional' },
  { t: 'staff_logs',       cols: 'staff_name, staff_group, shift_date, shift_start, shift_end, hours_worked, cost_actual, estimated_salary' },
  { t: 'recipes',          cols: 'id, name, type, menu_price, selling_price_ex_vat, vat_rate, portions, is_subrecipe, notes, updated_at, archived_at, business_id' },
  { t: 'review_themes',    cols: 'rating, sentiment, themes, key_phrase, published_at, replied_at, business_id' },
  { t: 'events',           cols: 'name, starts_at, venue_name, expected_impact, distance_km, business_id' },
]

for (const { t, cols } of TABLES) {
  const { data, error } = await db.from(t).select(cols).limit(1)
  console.log(`${t.padEnd(20)} ${error ? 'ERROR: ' + error.message : 'OK (' + (data?.length ?? 0) + ' rows)'}`)
}

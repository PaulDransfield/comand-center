import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const candidates = ['headline', 'message', 'detail', 'amount_kr', 'amount_sek', 'period_year', 'period_month', 'inserted_at', 'updated_at', 'snoozed_until', 'priority', 'confidence', 'recommendation', 'rule_id']
for (const c of candidates) {
  const { error: e } = await db.from('cost_insights').select(c).limit(0)
  if (!e) console.log(`  ${c}: ok`)
}

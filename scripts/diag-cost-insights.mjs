import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

// Insert a dummy then read back columns
const { error } = await db.from('cost_insights').insert({ org_id: '00000000-0000-0000-0000-000000000000', business_id: '00000000-0000-0000-0000-000000000000', kind: '_schema_probe', title: '_test' })
if (error) console.log(`insert error (expected): ${error.message}`)
// Don't actually insert — just look at column hints in the error message

// Try select with all common candidate columns to discover schema
const candidates = ['id', 'org_id', 'business_id', 'kind', 'category', 'title', 'description', 'severity', 'impact_sek', 'savings_sek', 'created_at', 'dismissed_at', 'evidence']
for (const c of candidates) {
  const { error: e } = await db.from('cost_insights').select(c).limit(0)
  if (e) console.log(`  ${c}: MISSING (${e.message.slice(0, 40)})`)
  else console.log(`  ${c}: ok`)
}

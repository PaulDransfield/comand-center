import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

for (const table of ['products', 'product_aliases', 'supplier_invoice_lines', 'cost_insights']) {
  const { data } = await db.from(table).select('*').limit(1)
  const cols = data?.[0] ? Object.keys(data[0]) : []
  console.log(`${table}: ${cols.length} cols`)
  console.log(`  ${cols.join(', ')}`)
  console.log('')
}

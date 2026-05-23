import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

// Test query — verify column exists by attempting a select
const { error: e1 } = await db.from('invoice_pdf_extractions').select('extracted_rows_json').limit(1)
if (e1) {
  console.log(`Column missing — needs SQL apply. error: ${e1.message}`)
  console.log('\nApply this SQL via Supabase SQL Editor:\n')
  console.log(`ALTER TABLE invoice_pdf_extractions ADD COLUMN IF NOT EXISTS extracted_rows_json JSONB;`)
} else {
  console.log('Column exists ✓')
}

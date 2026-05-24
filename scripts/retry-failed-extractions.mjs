// scripts/retry-failed-extractions.mjs
// Kick the retry endpoint for Chicce.
// Run: node --env-file=.env.production.local scripts/retry-failed-extractions.mjs

import { createClient } from '@supabase/supabase-js'

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const base   = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'

// We need a real authenticated session to call the owner endpoint.
// Alternative: directly do the reset + kick cron from this script.
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// 1. Reset all failed pdf_lookup_failed rows for Chicce
const candidates = []
let from = 0
while (true) {
  const { data, error } = await db
    .from('invoice_pdf_extractions')
    .select('id')
    .eq('business_id', CHICCE)
    .eq('status', 'failed')
    .like('error_message', 'pdf_lookup_failed%')
    .range(from, from + 999)
  if (error) { console.error('select error:', error.message); process.exit(1) }
  if (!data || data.length === 0) break
  candidates.push(...data)
  if (data.length < 1000) break
  from += 1000
}
console.log(`Found ${candidates.length} pdf_lookup_failed rows to retry`)

if (candidates.length === 0) {
  console.log('Nothing to reset.')
  process.exit(0)
}

let reset = 0
for (let i = 0; i < candidates.length; i += 500) {
  const slice = candidates.slice(i, i + 500).map(c => c.id)
  const { data, error } = await db
    .from('invoice_pdf_extractions')
    .update({
      status:        'pending',
      attempts:      0,
      error_message: null,
      started_at:    null,
      completed_at:  null,
    })
    .in('id', slice)
    .select('id')
  if (error) { console.error('update error:', error.message); break }
  reset += data?.length ?? 0
  console.log(`  reset batch ${i / 500 + 1}: +${data?.length ?? 0}`)
}
console.log(`Reset ${reset}/${candidates.length} rows to pending`)

// 2. Kick the extraction worker
const secret = process.env.CRON_SECRET
const kickUrl = `${base}/api/cron/inventory-pdf-extract-business`
console.log(`Kicking ${kickUrl}…`)
const adminSecret = process.env.ADMIN_SECRET
const res = await fetch(kickUrl, {
  method: 'POST',
  headers: {
    'Content-Type':   'application/json',
    'Authorization':  `Bearer ${secret}`,
    'x-cron-secret':  secret ?? '',
    'x-admin-secret': adminSecret ?? '',
  },
  body: JSON.stringify({
    business_id:      CHICCE,
    reset_extracting: true,
    chain_rematch:    true,
  }),
})
console.log(`Kick HTTP ${res.status}`)
const text = await res.text()
try { console.log(JSON.stringify(JSON.parse(text), null, 2)) } catch { console.log(text.slice(0, 500)) }
console.log('\nWorker is processing in the background. Watch /inventory/extractions for progress (refresh every minute).')

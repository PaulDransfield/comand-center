import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: ext } = await db
  .from('invoice_pdf_extractions')
  .select('status, completed_at, started_at')
  .eq('business_id', bizId)
  .range(0, 9999)
const counts = {}, oldestPending = []
let mostRecent = null
for (const r of ext ?? []) {
  counts[r.status] = (counts[r.status] ?? 0) + 1
  if (r.completed_at && (!mostRecent || r.completed_at > mostRecent)) mostRecent = r.completed_at
}
console.log('invoice_pdf_extractions:')
for (const [s, c] of Object.entries(counts).sort()) console.log(`  ${s}: ${c}`)
console.log(`Total: ${(ext ?? []).length}`)
console.log(`Most recent completion: ${mostRecent}`)

// Check if anything is stuck (started long ago, not completed)
const { data: stuck } = await db
  .from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, status, started_at, attempts, error_message')
  .eq('business_id', bizId)
  .eq('status', 'extracting')
  .limit(3)
console.log(`\nExtracting (stuck?): ${stuck?.length ?? 0}`)
for (const r of stuck ?? []) {
  const age = r.started_at ? Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60_000) : null
  console.log(`  #${r.fortnox_invoice_number} started=${r.started_at} (${age} min ago) attempts=${r.attempts}`)
}

// Failed ones — check for patterns
const { data: failed } = await db
  .from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, status, error_message, attempts')
  .eq('business_id', bizId)
  .in('status', ['failed', 'needs_review', 'no_pdf'])
  .limit(8)
console.log(`\nNon-extracted samples:`)
for (const r of failed ?? []) {
  console.log(`  #${r.fortnox_invoice_number} ${r.status} attempts=${r.attempts} err=${(r.error_message ?? '').slice(0, 80)}`)
}

// One-off: is the inventory backfill actually advancing, or stalled?
// Reads .env.local, dumps every inventory_backfill_state row + line counts.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// Minimal .env.local loader (no dependency on dotenv being installed).
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
)

const { data: states, error } = await db
  .from('inventory_backfill_state')
  .select('org_id, business_id, status, progress, started_at, finished_at, updated_at, error_message')
  .order('updated_at', { ascending: false })

if (error) { console.error(error); process.exit(1) }

const now = Date.now()
for (const s of states ?? []) {
  const { data: biz } = await db.from('businesses').select('name').eq('id', s.business_id).maybeSingle()
  const { count: linesTotal } = await db.from('supplier_invoice_lines')
    .select('*', { count: 'exact', head: true }).eq('business_id', s.business_id)
  const ageMin = s.updated_at ? ((now - new Date(s.updated_at).getTime()) / 60000).toFixed(1) : '?'
  const runMin = s.started_at ? ((now - new Date(s.started_at).getTime()) / 60000).toFixed(1) : '?'
  const p = s.progress ?? {}
  console.log('────────────────────────────────────────')
  console.log(`Business : ${biz?.name ?? '?'} (${s.business_id})`)
  console.log(`Status   : ${s.status}`)
  console.log(`Phase    : ${p.phase}`)
  console.log(`Invoices : ${p.invoices_processed} / ${p.invoices_found}  (inserted=${p.lines_inserted} matched=${p.lines_matched} needsReview=${p.lines_needs_review} skippedExisting=${p.lines_skipped_existing})`)
  console.log(`Lines DB : ${linesTotal} rows in supplier_invoice_lines`)
  console.log(`Started  : ${s.started_at}  (${runMin} min ago)`)
  console.log(`Updated  : ${s.updated_at}  (${ageMin} min ago)  <-- if this keeps growing, it's STALLED`)
  console.log(`Finished : ${s.finished_at}`)
  if (s.error_message) console.log(`Error    : ${s.error_message}`)
}
console.log('────────────────────────────────────────')

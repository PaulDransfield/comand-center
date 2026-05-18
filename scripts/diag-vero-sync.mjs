// Diagnose why Vero Italiano isn't syncing.
// Reads: integrations (status / last_sync_at / errors), recent revenue_logs,
// recent staff_logs, recent fortnox_uploads, recent daily_metrics.
//
// Run: node scripts/diag-vero-sync.mjs

import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const VERO_BUSINESS_ID = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const VERO_ORG_ID      = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const db = createClient(url, key)

function fmt(d) {
  if (!d) return '(null)'
  const dt = new Date(d)
  const ageMs = Date.now() - dt.getTime()
  const ageH = Math.round(ageMs / 3600000)
  const ageD = Math.round(ageMs / 86400000)
  return `${dt.toISOString()}  (${ageH < 48 ? ageH + 'h' : ageD + 'd'} ago)`
}

console.log('═══ Vero Italiano sync diagnostic ═══\n')

// 1. Integrations
console.log('── integrations ──')
const { data: ints, error: ie } = await db
  .from('integrations')
  .select('id, provider, department, status, last_sync_at, last_sync_error, error_count, backfill_status, backfill_finished_at, backfill_error, access_token_expires_at, created_at, updated_at')
  .or(`business_id.eq.${VERO_BUSINESS_ID},and(org_id.eq.${VERO_ORG_ID},business_id.is.null)`)
  .order('provider', { ascending: true })

if (ie) { console.error('ERR:', ie.message); process.exit(1) }
if (!ints?.length) {
  console.log('  (no integrations rows for this business)\n')
} else {
  for (const i of ints) {
    console.log(`  ${i.provider}${i.department ? '/' + i.department : ''}  id=${i.id}`)
    console.log(`    status:                 ${i.status}`)
    console.log(`    last_sync_at:           ${fmt(i.last_sync_at)}`)
    console.log(`    last_sync_error:        ${i.last_sync_error ?? '(none)'}`)
    console.log(`    error_count:            ${i.error_count ?? 0}`)
    if (i.provider === 'fortnox') {
      console.log(`    backfill_status:        ${i.backfill_status ?? '(null)'}`)
      console.log(`    backfill_finished_at:   ${fmt(i.backfill_finished_at)}`)
      console.log(`    backfill_error:         ${i.backfill_error ?? '(none)'}`)
      console.log(`    access_token_expires:   ${fmt(i.access_token_expires_at)}`)
    }
    console.log(`    updated_at:             ${fmt(i.updated_at)}`)
    console.log()
  }
}

// 2. Recent revenue_logs
console.log('── revenue_logs (last 10 by revenue_date desc) ──')
const { data: rev } = await db
  .from('revenue_logs')
  .select('revenue_date, revenue, covers, provider, created_at')
  .eq('business_id', VERO_BUSINESS_ID)
  .order('revenue_date', { ascending: false })
  .limit(10)
if (!rev?.length) console.log('  (no rows)')
else for (const r of rev) console.log(`  ${r.revenue_date}  rev=${r.revenue}  covers=${r.covers}  provider=${r.provider}  created=${r.created_at}`)
console.log()

// 3. Recent staff_logs
console.log('── staff_logs (last 10 by shift_date desc) ──')
const { data: staff } = await db
  .from('staff_logs')
  .select('shift_date, hours_worked, cost_actual, estimated_salary, pk_log_url, created_at')
  .eq('business_id', VERO_BUSINESS_ID)
  .order('shift_date', { ascending: false })
  .limit(10)
if (!staff?.length) console.log('  (no rows)')
else for (const s of staff) {
  const kind = s.pk_log_url?.endsWith('_scheduled') ? 'scheduled' : 'logged'
  console.log(`  ${s.shift_date}  hrs=${s.hours_worked}  cost=${s.cost_actual}  est=${s.estimated_salary}  kind=${kind}  created=${s.created_at}`)
}
console.log()

// 4. Recent daily_metrics
console.log('── daily_metrics (last 10) ──')
const { data: dm } = await db
  .from('daily_metrics')
  .select('date, revenue, staff_cost, covers, hours_worked, cost_source, updated_at')
  .eq('business_id', VERO_BUSINESS_ID)
  .order('date', { ascending: false })
  .limit(10)
if (!dm?.length) console.log('  (no rows)')
else for (const r of dm) console.log(`  ${r.date}  rev=${r.revenue}  staff=${r.staff_cost}  covers=${r.covers}  hrs=${r.hours_worked}  source=${r.cost_source}  upd=${r.updated_at}`)
console.log()

// 5. Recent fortnox_uploads
console.log('── fortnox_uploads (last 5) ──')
const { data: fu } = await db
  .from('fortnox_uploads')
  .select('id, period_year, period_month, status, source, created_via, created_at, applied_at')
  .eq('business_id', VERO_BUSINESS_ID)
  .order('created_at', { ascending: false })
  .limit(5)
if (!fu?.length) console.log('  (no rows)')
else for (const f of fu) console.log(`  ${f.period_year}-${String(f.period_month).padStart(2,'0')}  status=${f.status}  source=${f.source}  via=${f.created_via}  created=${f.created_at}`)
console.log()

// 6. Sync run history if it exists
console.log('── recent sync_runs (last 5, if table exists) ──')
const { data: sr, error: sre } = await db
  .from('sync_runs')
  .select('id, provider, status, error_message, started_at, finished_at, rows_inserted, rows_updated')
  .eq('business_id', VERO_BUSINESS_ID)
  .order('started_at', { ascending: false })
  .limit(5)
if (sre) console.log(`  (sync_runs table query failed: ${sre.message})`)
else if (!sr?.length) console.log('  (no rows)')
else for (const r of sr) console.log(`  ${r.provider}  ${r.status}  started=${r.started_at}  finished=${r.finished_at ?? '(running)'}  ins=${r.rows_inserted}/upd=${r.rows_updated}  err=${r.error_message ?? ''}`)
console.log()

import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Integration row
const { data: integ } = await db
  .from('integrations')
  .select('id, status, last_sync_at, last_sync_error, scope, granted_scopes, connected_at, updated_at')
  .eq('business_id', bizId)
  .eq('provider', 'fortnox')
  .maybeSingle()
console.log('Integration row:')
for (const [k, v] of Object.entries(integ ?? {})) {
  console.log(`  ${k}: ${typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '…' : v}`)
}

// tracker_data rows for Chicce — what's there
const { data: trackers, count: trackerCount } = await db
  .from('tracker_data')
  .select('period_year, period_month, source, created_via, fortnox_upload_id, updated_at', { count: 'exact' })
  .eq('business_id', bizId)
  .order('period_year', { ascending: false })
  .order('period_month', { ascending: false })
  .limit(15)
console.log(`\ntracker_data rows: ${trackerCount}`)
for (const t of trackers ?? []) {
  console.log(`  ${t.period_year}-${String(t.period_month).padStart(2, '0')}  source=${t.source}  via=${t.created_via}  upload=${t.fortnox_upload_id ?? '—'}  updated=${t.updated_at}`)
}

// Look for any backfill state
const { data: bfState } = await db
  .from('fortnox_backfill_state')
  .select('*')
  .eq('business_id', bizId)
  .order('created_at', { ascending: false })
  .limit(3)
console.log(`\nfortnox_backfill_state: ${bfState?.length ?? 0} rows`)
for (const s of bfState ?? []) {
  console.log(`  status=${s.status}  attempted=${s.attempted_months}  succeeded=${s.succeeded_months}  failed=${s.failed_months}  error=${(s.last_error ?? '').slice(0, 100)}  updated=${s.updated_at}`)
}

// Recent fortnox_uploads (PDFs that the backfill found and processed)
const { data: uploads, count: uploadCount } = await db
  .from('fortnox_uploads')
  .select('id, status, period_year, period_month, source, created_at', { count: 'exact' })
  .eq('business_id', bizId)
  .order('created_at', { ascending: false })
  .limit(10)
console.log(`\nfortnox_uploads: ${uploadCount} rows`)
for (const u of uploads ?? []) {
  console.log(`  ${u.period_year}-${String(u.period_month).padStart(2, '0')}  status=${u.status}  source=${u.source}  created=${u.created_at}`)
}

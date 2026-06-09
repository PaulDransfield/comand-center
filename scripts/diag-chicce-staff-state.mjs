import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

console.log('── Chicce staff/revenue inventory ──')

// 1. All integrations for Chicce
const { data: integrations } = await db
  .from('integrations')
  .select('provider, status, last_sync_at, last_error, metadata')
  .eq('business_id', CHICCE)
  .order('provider')
console.log(`Integrations for Chicce (${integrations?.length ?? 0}):`)
for (const i of integrations ?? []) {
  console.log(`  ${i.provider.padEnd(18)} status=${i.status}  last_sync=${i.last_sync_at?.slice(0,16) ?? 'never'}  err=${i.last_error ?? '-'}`)
}

// 2. staff_logs counts by provider
const { data: shiftCounts } = await db
  .from('staff_logs')
  .select('pk_log_url, shift_date, hours_worked')
  .eq('business_id', CHICCE)
  .gte('shift_date', '2026-05-01')
  .order('shift_date', { ascending: false })
  .limit(1000)
const byProv = new Map()
let totalHours = 0
for (const s of shiftCounts ?? []) {
  const prov = s.pk_log_url?.startsWith('caspeco-') ? 'caspeco'
            : s.pk_log_url?.includes('_scheduled') ? 'pk-scheduled'
            : s.pk_log_url ? 'pk-logged'
            : 'unknown'
  byProv.set(prov, (byProv.get(prov) ?? 0) + 1)
  totalHours += Number(s.hours_worked ?? 0)
}
console.log()
console.log(`staff_logs since 2026-05-01 (${shiftCounts?.length ?? 0} rows, ${totalHours.toFixed(0)} hrs):`)
for (const [k, v] of byProv) console.log(`  ${k}: ${v} rows`)

// 3. caspeco_employees count
const { count: caspecoEmpCount } = await db
  .from('caspeco_employees')
  .select('id', { count: 'exact', head: true })
  .eq('business_id', CHICCE)
console.log()
console.log(`caspeco_employees for Chicce: ${caspecoEmpCount}`)

// 4. daily_metrics recency
const { data: latestDaily } = await db
  .from('daily_metrics')
  .select('date, revenue, hours_worked, staff_cost')
  .eq('business_id', CHICCE)
  .order('date', { ascending: false })
  .limit(5)
console.log()
console.log('Latest daily_metrics rows:')
for (const d of latestDaily ?? []) console.log(`  ${d.date}  rev=${Math.round(Number(d.revenue ?? 0))} hrs=${Number(d.hours_worked ?? 0).toFixed(1)} staff=${Math.round(Number(d.staff_cost ?? 0))}`)

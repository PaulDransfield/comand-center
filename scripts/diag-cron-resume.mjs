// scripts/diag-cron-resume.mjs
//
// Compare what cron names appear in the BEFORE-resume window (last week
// of gap: 2026-05-02 → 2026-05-08) vs AFTER-resume (2026-05-09 → 2026-05-15).
// Anything newly present after May 9 is a likely candidate for the
// missing forecast-writer.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

async function fetchAll(from, to) {
  const out = []
  for (let pageFrom = 0; ; pageFrom += 1000) {
    const { data, error } = await db
      .from('cron_run_log')
      .select('cron_name, started_at, status, error')
      .gte('started_at', from)
      .lte('started_at', to)
      .order('started_at', { ascending: true })
      .range(pageFrom, pageFrom + 999)
    if (error) { console.error(error.message); process.exit(1) }
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

const beforeResume = await fetchAll('2026-05-02T00:00:00Z', '2026-05-08T23:59:59Z')
const afterResume  = await fetchAll('2026-05-09T00:00:00Z', '2026-05-15T23:59:59Z')
const now          = await fetchAll('2026-06-01T00:00:00Z', '2026-06-08T23:59:59Z')

function byCron(rows) {
  const m = new Map()
  for (const r of rows) {
    if (!m.has(r.cron_name)) m.set(r.cron_name, { total: 0, success: 0, error: 0 })
    const b = m.get(r.cron_name)
    b.total++
    if (r.status) b[r.status] = (b[r.status] ?? 0) + 1
  }
  return m
}

const bMap = byCron(beforeResume)
const aMap = byCron(afterResume)
const nMap = byCron(now)

console.log()
console.log(`Before resume (2026-05-02 → 2026-05-08):  ${beforeResume.length} rows`)
console.log(`After resume  (2026-05-09 → 2026-05-15):  ${afterResume.length} rows`)
console.log(`Now           (2026-06-01 → 2026-06-08):  ${now.length} rows`)
console.log()

// Anything in "after" that's NOT in "before"
console.log('── Crons NEW after May 9 (not present in 2026-05-02 to 2026-05-08):')
console.log()
const allAfter = [...aMap.keys()].sort()
for (const cron of allAfter) {
  if (!bMap.has(cron)) {
    const a = aMap.get(cron)
    const n = nMap.get(cron)
    console.log(`  ${cron.padEnd(40)}  after_count=${String(a.total).padStart(4)}  now_count=${String(n?.total ?? 0).padStart(4)}`)
  }
}
console.log()

// Anything in "before" that DROPPED after May 9
console.log('── Crons that ran 2026-05-02 to 2026-05-08 but NOT 2026-05-09 to 2026-05-15:')
const allBefore = [...bMap.keys()].sort()
let dropped = 0
for (const cron of allBefore) {
  if (!aMap.has(cron)) {
    const b = bMap.get(cron)
    console.log(`  ${cron.padEnd(40)}  before_count=${String(b.total).padStart(4)}`)
    dropped++
  }
}
if (dropped === 0) console.log('  (none)')
console.log()

// All forecast-related crons currently running
console.log('── Forecast-related crons in last 7 days:')
for (const cron of [...nMap.keys()].sort()) {
  if (cron.includes('forecast') || cron.includes('reconcil') || cron.includes('predict')) {
    const n = nMap.get(cron)
    const lastRow = now.filter(r => r.cron_name === cron).sort((a,b) => b.started_at.localeCompare(a.started_at))[0]
    console.log(`  ${cron.padEnd(40)}  runs=${String(n.total).padStart(3)}  last=${lastRow?.started_at?.slice(0,16).replace('T',' ') ?? '—'}  status=${lastRow?.status ?? '—'}`)
  }
}
console.log()

// Full cron list NOW with counts and statuses
console.log('── All crons active in last 7 days:')
console.log()
console.log('  Cron                                       runs   err  succ  last run')
for (const cron of [...nMap.keys()].sort()) {
  const n = nMap.get(cron)
  const lastRow = now.filter(r => r.cron_name === cron).sort((a,b) => b.started_at.localeCompare(a.started_at))[0]
  console.log(`  ${cron.padEnd(40)}  ${String(n.total).padStart(4)}  ${String(n.error ?? 0).padStart(4)}  ${String(n.success ?? 0).padStart(4)}  ${lastRow?.started_at?.slice(0,16).replace('T',' ') ?? '—'}`)
}

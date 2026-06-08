// scripts/diag-cron-gap.mjs
//
// Check cron_run_log for the Apr 6 → May 8 2026 window — what was
// running, what wasn't, and what changed.
//
// Outputs:
//   1. Total run count per cron name in the gap window vs a control
//      window before (Feb 1 → Mar 31) and a control window after
//      (May 9 → Jun 7). Anything that ran before+after but NOT during
//      the gap is the suspect.
//   2. List of error rows in the gap window.
//   3. First + last run timestamp per cron, gap-relative.
//
// Honest-incomplete: cron_run_log retention may not cover Apr 6 if it's
// pruned. We print a warning if the earliest row > Apr 6.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing env'); process.exit(1) }
const db = createClient(url, key, { auth: { persistSession: false } })

const GAP_FROM     = '2026-04-06'
const GAP_TO       = '2026-05-08'
const BEFORE_FROM  = '2026-02-01'
const BEFORE_TO    = '2026-03-31'
const AFTER_FROM   = '2026-05-09'
const AFTER_TO     = '2026-06-07'

console.log()
console.log(`cron_run_log gap analysis`)
console.log(`Gap window:     ${GAP_FROM} → ${GAP_TO}`)
console.log(`Control before: ${BEFORE_FROM} → ${BEFORE_TO}`)
console.log(`Control after:  ${AFTER_FROM} → ${AFTER_TO}`)
console.log()

// Paginated fetch of ALL rows in the union of windows
async function fetchWindow(from, to) {
  const out = []
  for (let pageFrom = 0; ; pageFrom += 1000) {
    const { data, error } = await db
      .from('cron_run_log')
      .select('cron_name, started_at, finished_at, status, error')
      .gte('started_at', from + 'T00:00:00Z')
      .lte('started_at', to + 'T23:59:59Z')
      .order('started_at', { ascending: true })
      .range(pageFrom, pageFrom + 999)
    if (error) { console.error(`Read failed in ${from}…${to}:`, error.message); process.exit(1) }
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

const [gapRows, beforeRows, afterRows] = await Promise.all([
  fetchWindow(GAP_FROM, GAP_TO),
  fetchWindow(BEFORE_FROM, BEFORE_TO),
  fetchWindow(AFTER_FROM, AFTER_TO),
])

console.log(`Rows in gap window:       ${gapRows.length}`)
console.log(`Rows in before-control:   ${beforeRows.length}`)
console.log(`Rows in after-control:    ${afterRows.length}`)

// Retention warning
const earliestEverPromise = await db
  .from('cron_run_log')
  .select('started_at')
  .order('started_at', { ascending: true })
  .limit(1)
const earliest = earliestEverPromise.data?.[0]?.started_at
if (earliest) {
  console.log(`Earliest row in entire log: ${earliest.slice(0, 10)}`)
  if (earliest.slice(0, 10) > GAP_FROM) {
    console.log(`  ⚠ Earlier rows pruned — gap-window data may be partial.`)
  }
}
console.log()

// Count by cron name in each window
function countByCron(rows) {
  const m = new Map()
  for (const r of rows) {
    const k = r.cron_name ?? '(unknown)'
    if (!m.has(k)) m.set(k, { total: 0, success: 0, error: 0, running: 0 })
    const b = m.get(k)
    b.total++
    b[r.status ?? 'running'] = (b[r.status ?? 'running'] ?? 0) + 1
  }
  return m
}

const beforeCount = countByCron(beforeRows)
const gapCount    = countByCron(gapRows)
const afterCount  = countByCron(afterRows)

// Union of all cron names across the three windows
const allCrons = new Set([
  ...beforeCount.keys(),
  ...gapCount.keys(),
  ...afterCount.keys(),
])

// Suspects: ran in BEFORE and AFTER but NOT in GAP
console.log('── Crons that ran in both control windows but NOT during the gap:')
console.log()
console.log('  Cron                                       before  gap  after')
const suspects = []
for (const cron of [...allCrons].sort()) {
  const b = beforeCount.get(cron)?.total ?? 0
  const g = gapCount.get(cron)?.total    ?? 0
  const a = afterCount.get(cron)?.total  ?? 0
  if (b > 0 && a > 0 && g === 0) {
    suspects.push({ cron, b, g, a })
    console.log(`  ${cron.padEnd(40)}  ${String(b).padStart(6)}  ${String(g).padStart(3)}  ${String(a).padStart(5)}`)
  }
}
if (suspects.length === 0) console.log('  (none — no clean "stopped during gap" candidates)')
console.log()

// Reduced activity: ran significantly LESS in gap than before+after
console.log('── Crons whose gap-window activity is < 50 % of before/after average:')
console.log()
console.log('  Cron                                       before  gap  after  drop %')
for (const cron of [...allCrons].sort()) {
  const b = beforeCount.get(cron)?.total ?? 0
  const g = gapCount.get(cron)?.total    ?? 0
  const a = afterCount.get(cron)?.total  ?? 0
  if (b === 0 || a === 0) continue
  if (g > 0 && suspects.some(s => s.cron === cron)) continue
  // Days in each window for fairness
  const days = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86_400_000) + 1
  const bRate = b / days(BEFORE_FROM, BEFORE_TO)
  const gRate = g / days(GAP_FROM, GAP_TO)
  const aRate = a / days(AFTER_FROM, AFTER_TO)
  const baseline = (bRate + aRate) / 2
  if (baseline === 0) continue
  const ratio = gRate / baseline
  if (ratio < 0.5 && g > 0) {
    const dropPct = ((1 - ratio) * 100).toFixed(0)
    console.log(`  ${cron.padEnd(40)}  ${String(b).padStart(6)}  ${String(g).padStart(3)}  ${String(a).padStart(5)}   ${dropPct}%`)
  }
}
console.log()

// Errors during the gap window
const gapErrors = gapRows.filter(r => r.status === 'error')
console.log(`── Errors in gap window: ${gapErrors.length} rows`)
if (gapErrors.length > 0) {
  console.log()
  console.log('  Date         Cron                              Error excerpt')
  for (const e of gapErrors.slice(0, 30)) {
    const date = (e.started_at ?? '').slice(0, 10)
    const cron = (e.cron_name ?? '').padEnd(35)
    const msg  = (e.error ?? '').replace(/\s+/g, ' ').slice(0, 80)
    console.log(`  ${date}   ${cron}  ${msg}`)
  }
  if (gapErrors.length > 30) console.log(`  … and ${gapErrors.length - 30} more`)
}
console.log()

// All distinct cron names that ran in the gap window — useful to see
// what WAS active vs what wasn't
console.log('── Crons that DID run during the gap window:')
console.log()
console.log('  Cron                                       runs  err  succ  first run        last run')
for (const cron of [...gapCount.keys()].sort()) {
  const c = gapCount.get(cron)
  const cronRows = gapRows.filter(r => r.cron_name === cron)
  const first = cronRows[0]?.started_at?.slice(0, 16).replace('T', ' ')
  const last  = cronRows[cronRows.length - 1]?.started_at?.slice(0, 16).replace('T', ' ')
  console.log(`  ${cron.padEnd(40)}  ${String(c.total).padStart(4)}  ${String(c.error ?? 0).padStart(3)}  ${String(c.success ?? 0).padStart(4)}  ${first}  ${last}`)
}

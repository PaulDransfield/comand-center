// Read-only: inventory_backfill_state for ALL businesses (prod) — to see
// which businesses' scanners are actually running.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
for (const line of readFileSync('.env.production.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: states } = await db.from('inventory_backfill_state')
  .select('business_id, org_id, status, progress, updated_at, finished_at')
  .order('updated_at', { ascending: false })

const now = Date.now()
console.log('── inventory_backfill_state (all businesses) ──')
for (const s of states ?? []) {
  const { data: biz } = await db.from('businesses').select('name').eq('id', s.business_id).maybeSingle()
  const ageMin = s.updated_at ? ((now - new Date(s.updated_at).getTime()) / 60000).toFixed(1) : '?'
  const op = s.progress?.operation ?? (String(s.progress?.phase ?? '').startsWith('pdf') ? 'pdf' : 'lines')
  console.log(`  ${(biz?.name ?? '?').padEnd(18)} ${String(s.status).padEnd(11)} op=${String(op).padEnd(16)} phase=${String(s.progress?.phase ?? '-').padEnd(24)} updated ${ageMin}min ago  biz=${s.business_id.slice(0,8)} org=${s.org_id.slice(0,8)}`)
}

console.log('\n── fortnox integrations backfill_status ──')
const { data: integs } = await db.from('integrations')
  .select('business_id, org_id, backfill_status, backfill_finished_at')
  .eq('provider', 'fortnox')
for (const i of integs ?? []) {
  const { data: biz } = await db.from('businesses').select('name').eq('id', i.business_id).maybeSingle()
  console.log(`  ${(biz?.name ?? '?').padEnd(18)} backfill=${String(i.backfill_status ?? '-').padEnd(11)} biz=${(i.business_id ?? '?').slice(0,8)} org=${(i.org_id ?? '?').slice(0,8)}`)
}

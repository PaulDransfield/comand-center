// One-off: reset stale 'running'/'pending' inventory_backfill_state rows
// (not touched in >30 min = dead worker) to 'completed', so the sync banner
// stops showing perpetual "syncing" on idle/onboarded customers. Active rows
// (recently updated) are left alone.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
for (const line of readFileSync('.env.production.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString()
const { data, error } = await db.from('inventory_backfill_state')
  .update({ status: 'completed' })
  .in('status', ['running', 'pending'])
  .lt('updated_at', cutoff)
  .select('business_id, status, updated_at')
if (error) { console.error(error); process.exit(1) }
console.log(`Reset ${data?.length ?? 0} stale row(s):`)
for (const r of data ?? []) console.log(`  ${r.business_id.slice(0,8)} → ${r.status} (was stale since ${r.updated_at})`)

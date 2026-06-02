// One-shot: apply M119-PRODUCTS-PACK-SOURCE.sql via the service role.
// ALTER + COMMENT + index; idempotent; safe to re-run.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const sql = fs.readFileSync('sql/M119-PRODUCTS-PACK-SOURCE.sql', 'utf-8')

// Strip BEGIN/COMMIT lines — Supabase's rpc('exec') wraps statements in
// its own transaction. We pass the inner DDL.
const inner = sql
  .split('\n')
  .filter(l => !/^\s*(BEGIN|COMMIT)\s*;/i.test(l))
  .join('\n')

console.log('Applying M119 — ALTER TABLE products ADD COLUMN pack_source TEXT')
console.log('───────────────────────────────────────────────────────────────')

// Use the rpc('exec_sql') pattern? Check what's available. Most likely
// we need to execute via raw fetch to the rest endpoint, or via the
// supabase admin api. Simplest path: pgmeta endpoint.
// Actually — for one-off DDL the cleanest is the SQL editor in
// the dashboard, but we can use a direct fetch to the database via the
// supabase REST `query` if enabled.
//
// Cleaner: use postgres connection string if we have it.

// Try: use a stored fn `exec_sql` if it exists.
let applied = false
try {
  const { error } = await db.rpc('exec_sql', { sql: inner })
  if (!error) {
    applied = true
    console.log('Applied via rpc(exec_sql)')
  } else {
    console.warn('rpc(exec_sql) not available:', error.message)
  }
} catch (e) {
  console.warn('rpc(exec_sql) failed:', e.message)
}

if (!applied) {
  console.log('\nNo rpc(exec_sql) available. Run the following SQL manually in the Supabase SQL editor:')
  console.log('───────────────────────────────────────────────────────────────')
  console.log(sql)
  console.log('───────────────────────────────────────────────────────────────')
  process.exit(2)
}

// Verify the column exists.
const { data: col, error: colErr } = await db.from('products').select('pack_source').limit(1)
if (colErr) {
  console.error('Verification failed — column not found:', colErr.message)
  process.exit(1)
}
console.log('Verified: products.pack_source column exists.')
process.exit(0)

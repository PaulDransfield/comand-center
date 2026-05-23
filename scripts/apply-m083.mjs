// scripts/apply-m083.mjs — apply M083 via service role
// Run: node --env-file=.env.production.local scripts/apply-m083.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sql = readFileSync('sql/M083-SUPPLIER-CLASSIFICATIONS.sql', 'utf8')

// pg_query function isn't standard — try via Supabase's REST sql endpoint
// (only available with service role on Pro plans). Fallback: print SQL.
const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/exec_sql`
const resp = await fetch(url, {
  method: 'POST',
  headers: {
    'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type':  'application/json',
  },
  body: JSON.stringify({ q: sql }),
})

if (resp.ok) {
  console.log('applied via exec_sql RPC')
} else {
  console.log(`exec_sql RPC unavailable (${resp.status}). Apply via Supabase SQL editor:`)
  console.log('\n---SQL---')
  console.log(sql)
  console.log('---END---\n')
}

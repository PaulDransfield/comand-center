#!/usr/bin/env node
// Verifies M024-PK-SYNC-CURSORS.sql has been applied to Supabase.
// Run after pasting the SQL into Supabase SQL Editor.
//
// Usage: node scripts/verify-m024.mjs

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local'); process.exit(1) }

const r = await fetch(`${URL}/rest/v1/integrations?select=id,pk_sync_cursors&limit=1`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
})

if (!r.ok) {
  const body = await r.text()
  if (body.includes('pk_sync_cursors') && body.includes('does not exist')) {
    console.error('FAIL: pk_sync_cursors column does not exist.')
    console.error('Apply M024-PK-SYNC-CURSORS.sql in Supabase SQL Editor, then re-run this script.')
    process.exit(2)
  }
  console.error(`FAIL: Supabase returned ${r.status}: ${body.slice(0, 200)}`)
  process.exit(1)
}

const rows = await r.json()
console.log('OK — pk_sync_cursors column exists.')
if (rows.length) {
  console.log(`Sample row: pk_sync_cursors = ${JSON.stringify(rows[0].pk_sync_cursors)}`)
} else {
  console.log('(integrations table is empty)')
}

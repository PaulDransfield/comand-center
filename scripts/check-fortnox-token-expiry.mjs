#!/usr/bin/env node
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
for (const [k, v] of Object.entries(env)) {
  if (!(k in process.env) || /^mock_|^https:\/\/mock-/.test(process.env[k] ?? '')) process.env[k] = v
}
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}
const ORG = '22adf147-91c6-4e6a-840c-d1ab9a415d2f'
const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const rows = await q(`integrations?org_id=eq.${ORG}&business_id=eq.${BIZ}&provider=eq.fortnox&select=id,status,credentials_enc,last_sync_at`)
console.log(`rows: ${rows.length}`)
if (rows.length) {
  const row = rows[0]
  console.log(`  id=${row.id}  status=${row.status}  last_sync=${row.last_sync_at}`)
  console.log(`  cred_enc len: ${(row.credentials_enc ?? '').length}`)
}

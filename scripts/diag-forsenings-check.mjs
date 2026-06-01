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
const URL = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
const h = { apikey: KEY, Authorization: `Bearer ${KEY}` }
async function q(path) {
  const fullUrl = `${URL}/rest/v1/${path}`
  console.log(`URL: ${fullUrl.slice(0, 150)}`)
  const r = await fetch(fullUrl, { headers: h })
  if (!r.ok) {
    console.log(`status ${r.status}: ${(await r.text()).slice(0, 300)}`)
    return []
  }
  return r.json()
}

const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

console.log('1. All Martin Servera needs_review lines at Vero (full pull):')
const allMS = await q(`supplier_invoice_lines?business_id=eq.${VERO}&match_status=eq.needs_review&product_alias_id=is.null&supplier_name_snapshot=ilike.*Martin*Servera*&select=raw_description,total_excl_vat&limit=50`)
console.log(`${allMS.length} rows`)
for (const r of allMS.slice(0, 8)) console.log(`  "${r.raw_description}" — ${r.total_excl_vat}`)

console.log('\n2. Substring search with ASCII chars only:')
const ascii = await q(`supplier_invoice_lines?business_id=eq.${VERO}&match_status=eq.needs_review&product_alias_id=is.null&raw_description=ilike.*orsening*&select=raw_description&limit=10`)
console.log(`${ascii.length} rows`)
for (const r of ascii.slice(0, 5)) console.log(`  "${r.raw_description}"`)

console.log('\n3. Substring search with å/ö (raw):')
const sw = await q(`supplier_invoice_lines?business_id=eq.${VERO}&match_status=eq.needs_review&product_alias_id=is.null&raw_description=ilike.*försening*&select=raw_description&limit=10`)
console.log(`${sw.length} rows`)
for (const r of sw.slice(0, 5)) console.log(`  "${r.raw_description}"`)

console.log('\n4. Substring search with å/ö (encoded):')
const encoded = await q(`supplier_invoice_lines?business_id=eq.${VERO}&match_status=eq.needs_review&product_alias_id=is.null&raw_description=ilike.*${encodeURIComponent('försening')}*&select=raw_description&limit=10`)
console.log(`${encoded.length} rows`)
for (const r of encoded.slice(0, 5)) console.log(`  "${r.raw_description}"`)

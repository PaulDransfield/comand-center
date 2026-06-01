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
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

for (const inv of ['8608', '8688', '8923']) {
  const r = await fetch(`${URL}/rest/v1/invoice_pdf_extractions?business_id=eq.${VERO}&fortnox_invoice_number=eq.${inv}&select=fortnox_invoice_number,status,attempts,rows_extracted,total_extracted,total_header,updated_at,validation_warnings`, { headers: h })
  const j = await r.json()
  console.log(`${inv}:`, JSON.stringify(j[0] ?? {}, null, 2))
}

// And line count for one of them
const rows = await fetch(`${URL}/rest/v1/supplier_invoice_lines?business_id=eq.${VERO}&fortnox_invoice_number=eq.8608&select=count`, { headers: { ...h, Prefer: 'count=exact' }})
console.log(`\n8608 supplier_invoice_lines count: ${rows.headers.get('content-range')}`)

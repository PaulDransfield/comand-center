import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Look up the alias directly with no filter
// Find the line by total amount with no business filter
const { data: ln, error: lnErr } = await db.from('supplier_invoice_lines')
  .select('id, product_alias_id, raw_description, quantity, price_per_unit, total_excl_vat, vat_rate, business_id, fortnox_invoice_number, unit')
  .gte('total_excl_vat', 4655.0).lte('total_excl_vat', 4656.0)
  .limit(20)
console.log(`Lines with total ~4655.67: ${ln?.length} err=${lnErr?.message}`)
const targetLine = (ln ?? []).find(l => l.raw_description?.toLowerCase().includes('julienne'))
console.log('Target line:', JSON.stringify(targetLine, null, 2))
const aliasFullId = targetLine?.product_alias_id
const { data: a, error } = await db.from('product_aliases')
  .select('*')
  .eq('id', aliasFullId)
console.log('Alias rows:', a?.length, error?.message)
for (const r of a ?? []) console.log(`  full id: ${r.id}  product=${r.product_id}  is_active=${r.is_active}  norm="${r.normalized_description}"  supplier="${r.supplier_name_snapshot}"`)

// Also pull all lines for the same invoice
const invNum = targetLine?.fortnox_invoice_number
const bizId = targetLine?.business_id
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('id, raw_description, quantity, unit, price_per_unit, total_excl_vat, product_alias_id, match_status, vat_rate, currency')
  .eq('fortnox_invoice_number', invNum)
  .eq('business_id', bizId)
  .order('id')
console.log(`\nAll lines on invoice 3174: ${lines?.length}`)
// Check distinct currencies + compute ratio on each line
const currencies = new Set()
for (const l of lines ?? []) {
  currencies.add(l.currency)
  const computed = (Number(l.quantity) || 0) * (Number(l.price_per_unit) || 0)
  const ratio = l.total_excl_vat && computed ? (Number(l.total_excl_vat) / computed) : null
  console.log(`  cur=${l.currency} qty=${l.quantity} ppu=${l.price_per_unit}  total=${l.total_excl_vat}  ratio=${ratio?.toFixed(3)}  "${l.raw_description?.slice(0,50)}"`)
}
console.log(`\nCurrencies: ${[...currencies].join(', ')}`)

// Also fetch the invoice currency from the parent extraction
const { data: ext } = await db.from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, currency, total_excl_vat, business_id')
  .eq('fortnox_invoice_number', invNum)
  .eq('business_id', bizId)
console.log(`\nInvoice extractions: ${ext?.length}`)
for (const e of ext ?? []) console.log(`  inv=${e.fortnox_invoice_number}  cur=${e.currency}  total_excl=${e.total_excl_vat}`)

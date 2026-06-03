import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const distinct = new Map()
let from = 0
while (true) {
  const { data } = await db.from('supplier_invoice_lines')
    .select('supplier_fortnox_number, article_number, raw_description, invoice_date')
    .ilike('supplier_name_snapshot', '%spendrups%')
    .not('article_number','is',null)
    .order('invoice_date', { ascending: false })
    .range(from, from + 999)
  if (!data?.length) break
  for (const l of data) {
    const a = String(l.article_number ?? '').trim()
    if (a.length !== 7 || !/^\d+$/.test(a)) continue
    const k = `${l.supplier_fortnox_number}|${a}`
    if (!distinct.has(k)) distinct.set(k, l.raw_description)
  }
  if (data.length < 1000) break
  from += 1000
}
console.log(`Distinct Spendrups 7-digit articles: ${distinct.size}`)
let i = 0
for (const [k, name] of distinct) {
  if (i++ < 10) console.log(`  ${k}  "${name}"`)
}

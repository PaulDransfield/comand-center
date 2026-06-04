// Diagnose why "Lök Röd 1kg" thumbnail shows a Coke can.
// Walks: product → aliases → supplier_invoice_lines → unique
// (supplier, article#) combos → supplier_articles to see which one
// is feeding the bad image.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: prods } = await db.from('products').select('id, name, business_id, archived_at').ilike('name', '%lök röd%')
console.log(`Products matching "lök röd": ${prods?.length}`)
for (const p of prods ?? []) {
  console.log(`\n── ${p.id.slice(0,8)} "${p.name}"  biz=${p.business_id.slice(0,8)}  archived=${p.archived_at ?? 'no'}`)
  const { data: aliases } = await db.from('product_aliases')
    .select('id, supplier_name_snapshot, raw_description, is_active, match_method')
    .eq('product_id', p.id)
  console.log(`  aliases: ${aliases?.length}`)
  for (const a of aliases ?? []) {
    console.log(`    [${a.is_active ? 'active' : 'INACTIVE'}] ${a.id.slice(0,8)}  supplier="${a.supplier_name_snapshot}"  method=${a.match_method}`)
    console.log(`        raw="${a.raw_description?.slice(0, 90)}"`)
  }
  const aliasIds = (aliases ?? []).map(a => a.id)
  if (aliasIds.length === 0) continue

  const { data: lines } = await db.from('supplier_invoice_lines')
    .select('supplier_fortnox_number, article_number, description, invoice_date, product_alias_id')
    .in('product_alias_id', aliasIds)
    .not('article_number','is',null)
    .order('invoice_date', { ascending: false })
    .limit(20)
  console.log(`  last 20 invoice lines per alias:`)
  for (const l of lines ?? []) {
    console.log(`    ${l.invoice_date}  sup=${l.supplier_fortnox_number}  art=${l.article_number}  "${l.description?.slice(0,60)}"`)
  }

  const combos = [...new Set((lines ?? []).map(l => `${l.supplier_fortnox_number}|${l.article_number}`))]
  console.log(`  unique combos: ${combos.length}`)
  for (const k of combos.slice(0, 6)) {
    const [sup, art] = k.split('|')
    const { data: sa } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, official_name, brand, image_cached_path, fetch_status')
      .eq('supplier_fortnox_number', sup).eq('article_number', art).maybeSingle()
    console.log(`    combo ${k}  →  "${sa?.official_name ?? '(no article row)'}" brand=${sa?.brand}  img=${sa?.image_cached_path ? 'YES' : 'NO'}  status=${sa?.fetch_status}`)
  }
}

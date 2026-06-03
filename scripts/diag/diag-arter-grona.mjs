// Why didn't ÄRTER GRÖNA orphan get caught by the auto-merge?
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Find the orphan
const { data: prods } = await db.from('products')
  .select('id, name, archived_at')
  .eq('business_id', CHICCE)
  .ilike('name', '%ärter%gröna%2,5%')
  .limit(10)
for (const p of prods ?? []) console.log(`product ${p.id.slice(0,8)} "${p.name}" archived=${p.archived_at ?? '∅'}`)

// For each, check aliases + lines
for (const p of prods ?? []) {
  if (p.archived_at) continue
  const { data: aliases } = await db.from('product_aliases').select('id').eq('product_id', p.id).eq('is_active', true)
  console.log(`\n  ${p.id.slice(0,8)} "${p.name}" — ${aliases?.length ?? 0} active alias(es)`)
  if (aliases?.length) {
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('article_number, raw_description, invoice_date')
      .in('product_alias_id', aliases.map(a => a.id))
      .order('invoice_date', { ascending: false }).limit(5)
    for (const l of lines ?? []) console.log(`    ${l.invoice_date} art=${l.article_number} "${l.raw_description?.slice(0,60)}"`)
  }
}

// Also: where is article 345603 in the lines?
console.log(`\n=== Lines with article 345603 at Chicce ===`)
const { data: artLines } = await db.from('supplier_invoice_lines')
  .select('id, raw_description, invoice_date, product_alias_id')
  .eq('business_id', CHICCE)
  .eq('article_number', '345603')
  .order('invoice_date', { ascending: false }).limit(10)
for (const l of artLines ?? []) console.log(`  ${l.invoice_date} alias=${l.product_alias_id?.slice(0,8) ?? '∅'} "${l.raw_description?.slice(0,60)}"`)

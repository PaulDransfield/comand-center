// Why aren't thumbs appearing for these products despite supplier_articles
// having images? Walk product → aliases → supplier_invoice_lines → supplier_articles
// for each one and find the breakpoint.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Products the owner flagged as having no thumb but expecting one
const NAMES = [
  'Ägg Hel Flyt 5kg',
  'Kalvhögrev Rose Nl 5kg',
  'Kalvytterfile Rose Mk',
  'Lök Silver',
  'Mascarpone 2',
  'Blåbär 2,5kg',
  'Bär Jordgubbar',
]

const CHICCE_ID = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

for (const name of NAMES) {
  console.log('\n=== ' + name + ' ===')
  const { data: prods } = await db.from('products')
    .select('id, name, business_id')
    .eq('business_id', CHICCE_ID)
    .ilike('name', `%${name}%`)
    .is('archived_at', null)
    .limit(5)
  if (!prods?.length) { console.log('  NO PRODUCT MATCH'); continue }
  for (const p of prods) {
    console.log(`  product ${p.id.slice(0,8)} "${p.name}"`)
    const { data: aliases } = await db.from('product_aliases')
      .select('id, supplier_fortnox_number, normalised_description, match_method')
      .eq('product_id', p.id)
      .eq('is_active', true)
    console.log(`    ${aliases?.length ?? 0} active alias(es)`)
    if (!aliases?.length) { console.log('    NO ALIASES'); continue }
    const aliasIds = aliases.map(a => a.id)
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('supplier_fortnox_number, article_number, invoice_date')
      .in('product_alias_id', aliasIds)
      .not('article_number', 'is', null)
      .not('supplier_fortnox_number', 'is', null)
      .order('invoice_date', { ascending: false })
      .limit(5)
    console.log(`    recent lines with article_number: ${lines?.length ?? 0}`)
    for (const l of lines ?? []) console.log(`      ${l.invoice_date} sup=${l.supplier_fortnox_number} art="${l.article_number}"`)
    if (!lines?.length) {
      // No article_number on lines — check lines without it
      const { count } = await db.from('supplier_invoice_lines')
        .select('*', { count: 'exact', head: true })
        .in('product_alias_id', aliasIds)
      console.log(`    total lines (incl. null article): ${count ?? 0}`)
      continue
    }
    // For each unique (sup, art), check supplier_articles
    const combos = new Set(lines.map(l => `${l.supplier_fortnox_number}|${l.article_number}`))
    for (const k of combos) {
      const [sup, art] = k.split('|')
      const { data: sa } = await db.from('supplier_articles')
        .select('supplier_fortnox_number, article_number, image_cached_path, fetch_status, official_name')
        .eq('supplier_fortnox_number', sup)
        .eq('article_number', art)
        .maybeSingle()
      if (!sa) {
        // Try with stripped/padded leading zeros
        const stripped = art.replace(/^0+/, '')
        const { data: sa2 } = await db.from('supplier_articles')
          .select('supplier_fortnox_number, article_number, image_cached_path, fetch_status')
          .eq('supplier_fortnox_number', sup)
          .eq('article_number', stripped)
          .maybeSingle()
        if (sa2) {
          console.log(`      ${k} ⚠ ARTICLE_NUMBER MISMATCH — line has "${art}" but supplier_articles has "${sa2.article_number}" (leading-zero diff)`)
        } else {
          console.log(`      ${k} ✗ NO supplier_articles row`)
        }
        continue
      }
      console.log(`      ${k} → status=${sa.fetch_status} img=${sa.image_cached_path ? 'YES' : 'NO'} "${sa.official_name?.slice(0,50)}"`)
    }
  }
}

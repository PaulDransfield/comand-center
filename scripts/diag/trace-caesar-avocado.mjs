// Walk the Caesar Salad recipe at Chicce -> find the avocado ingredient
// -> trace the price the cost engine is pulling.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: recipes } = await db.from('recipes')
  .select('id, name, business_id')
  .ilike('name', '%caesar%').is('archived_at', null)
console.log(`Caesar recipes: ${recipes?.length}`)
for (const r of recipes ?? []) {
  console.log(`\n── ${r.id.slice(0,8)} "${r.name}"  biz=${r.business_id.slice(0,8)}`)
  const { data: ings } = await db.from('recipe_ingredients')
    .select('id, product_id, subrecipe_id, quantity, unit, position')
    .eq('recipe_id', r.id).order('position')
  for (const ing of ings ?? []) {
    if (ing.subrecipe_id) {
      const { data: sub } = await db.from('recipes').select('name').eq('id', ing.subrecipe_id).maybeSingle()
      console.log(`  [sub] ${ing.quantity} ${ing.unit}  → "${sub?.name}"`)
    } else if (ing.product_id) {
      const { data: p } = await db.from('products')
        .select('id, name, pack_size, base_unit, invoice_unit, pack_source')
        .eq('id', ing.product_id).maybeSingle()
      const isAvo = p?.name?.toLowerCase().includes('avocado')
      console.log(`  ${isAvo ? '** ' : '   '}${ing.quantity} ${ing.unit}  → ${p?.id?.slice(0,8)} "${p?.name}"  pack=${p?.pack_size} ${p?.base_unit} inv=${p?.invoice_unit} src=${p?.pack_source}`)
      if (isAvo) {
        // Trace the price.
        const { data: aliases } = await db.from('product_aliases')
          .select('id, raw_description, is_active, supplier_name_snapshot')
          .eq('product_id', p.id).eq('is_active', true)
        console.log(`      aliases: ${aliases?.length}`)
        for (const a of aliases ?? []) console.log(`        ${a.id.slice(0,8)}  "${a.raw_description}"  sup="${a.supplier_name_snapshot}"`)
        const aliasIds = (aliases ?? []).map(a => a.id)
        const { data: lines } = await db.from('supplier_invoice_lines')
          .select('description, quantity, invoice_unit, unit_price, price_per_unit, line_total_excl_vat, line_total_excl_vat_sek, currency, invoice_date, match_status, product_alias_id')
          .in('product_alias_id', aliasIds).order('invoice_date', { ascending: false }).limit(5)
        console.log(`      latest lines: ${lines?.length}`)
        for (const l of lines ?? []) {
          console.log(`        ${l.invoice_date} ${l.match_status}  qty=${l.quantity} ${l.invoice_unit}  ppu=${l.price_per_unit} unit_p=${l.unit_price}  tot=${l.line_total_excl_vat} ${l.currency} sek=${l.line_total_excl_vat_sek}`)
          console.log(`           "${l.description?.slice(0,70)}"`)
        }
      }
    }
  }
}

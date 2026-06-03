// Simulates the GET /api/inventory/items/[id]/supplier-article logic locally.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local', 'utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const productId = '5d001b21-f887-47bc-900f-5b8e45f4dbf6'  // Frityrolja Long Life @ Chicce

const { data: product } = await db.from('products').select('id, business_id, name').eq('id', productId).maybeSingle()
console.log('product:', product?.name, '@', product?.business_id)

const { data: aliases } = await db.from('product_aliases').select('id').eq('product_id', productId).eq('is_active', true)
const aliasIds = (aliases ?? []).map(a => a.id)
console.log('aliases (active):', aliasIds.length)

const combos = new Map()
for (let i = 0; i < aliasIds.length; i += 100) {
  const slice = aliasIds.slice(i, i + 100)
  const { data } = await db.from('supplier_invoice_lines').select('supplier_fortnox_number, article_number, invoice_date').eq('business_id', product.business_id).in('product_alias_id', slice).not('article_number', 'is', null).not('supplier_fortnox_number', 'is', null).order('invoice_date', { ascending: false }).limit(200)
  for (const l of data ?? []) {
    const k = `${l.supplier_fortnox_number}|${l.article_number}`
    if (!combos.has(k) || l.invoice_date > combos.get(k).last_seen) {
      combos.set(k, { supplier_fortnox_number: l.supplier_fortnox_number, article_number: l.article_number, last_seen: l.invoice_date })
    }
  }
}
console.log('combos:', [...combos.values()])

const orParts = []
for (const c of combos.values()) orParts.push(`and(supplier_fortnox_number.eq.${c.supplier_fortnox_number},article_number.eq.${c.article_number})`)
console.log('OR query string:', orParts.join(','))
const { data: articles, error } = await db.from('supplier_articles').select('*').or(orParts.join(',')).eq('fetch_status', 'ok').order('updated_at', { ascending: false })
console.log('error:', error?.message)
console.log('articles returned:', articles?.length ?? 0)
for (const a of articles ?? []) {
  console.log('  →', a.article_number, '|', a.official_name, '| image_cached_path=', a.image_cached_path)
}

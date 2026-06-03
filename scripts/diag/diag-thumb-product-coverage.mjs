// Coverage breakdown: of all active products at a business, how many
// successfully resolve to a supplier-article image via the batch endpoint
// pipeline? Surface the drop-off at each step.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

for (const biz of [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]) {
  console.log(`\n=== ${biz.name} ===`)

  // 1. All active products in food/beverage/alcohol (the default items filter)
  const products = []
  let from = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, category, default_supplier_name')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .in('category', ['food','beverage','alcohol'])
      .order('id').range(from, from + 999)
    if (!data?.length) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`Total sellable products: ${products.length}`)

  // 2. Products with at least 1 active alias
  const productIds = products.map(p => p.id)
  const productsWithAlias = new Set()
  const aliasToProduct = new Map()
  for (let i = 0; i < productIds.length; i += 200) {
    const slice = productIds.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('product_id', slice).eq('is_active', true)
    for (const a of aliases ?? []) {
      productsWithAlias.add(a.product_id)
      aliasToProduct.set(a.id, a.product_id)
    }
  }
  console.log(`Products with ≥1 active alias: ${productsWithAlias.size}`)

  // 3. Products whose aliases have lines with article_number
  const productsWithArticle = new Set()
  const productCombos = new Map()  // pid → (sup|art)
  const aliasIds = [...aliasToProduct.keys()]
  for (let i = 0; i < aliasIds.length; i += 200) {
    const slice = aliasIds.slice(i, i + 200)
    const { data: lines } = await db.from('supplier_invoice_lines')
      .select('product_alias_id, supplier_fortnox_number, article_number, invoice_date')
      .in('product_alias_id', slice)
      .not('article_number', 'is', null)
      .not('supplier_fortnox_number', 'is', null)
      .order('invoice_date', { ascending: false }).limit(5000)
    for (const l of lines ?? []) {
      const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
      productsWithArticle.add(pid)
      if (!productCombos.has(pid)) productCombos.set(pid, `${l.supplier_fortnox_number}|${l.article_number}`)
    }
  }
  console.log(`Products with ≥1 line with article_number: ${productsWithArticle.size}`)

  // 4. Products whose (supplier, article) is in supplier_articles
  const allCombos = [...new Set(productCombos.values())]
  const articleSet = new Set()
  for (let i = 0; i < allCombos.length; i += 60) {
    const slice = allCombos.slice(i, i + 60)
    const orParts = slice.map(k => { const [s,a] = k.split('|'); return `and(supplier_fortnox_number.eq.${s},article_number.eq.${a})` })
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, image_cached_path, fetch_status')
      .or(orParts.join(','))
      .eq('fetch_status', 'ok')
    for (const r of data ?? []) articleSet.add(`${r.supplier_fortnox_number}|${r.article_number}`)
  }
  let withArticleRow = 0
  for (const [pid, combo] of productCombos) if (articleSet.has(combo)) withArticleRow++
  console.log(`Products with a matching supplier_articles row: ${withArticleRow}`)

  // 5. Products whose supplier_articles row has image_cached_path
  const imageSet = new Set()
  for (let i = 0; i < allCombos.length; i += 60) {
    const slice = allCombos.slice(i, i + 60)
    const orParts = slice.map(k => { const [s,a] = k.split('|'); return `and(supplier_fortnox_number.eq.${s},article_number.eq.${a})` })
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, image_cached_path')
      .or(orParts.join(','))
      .eq('fetch_status', 'ok')
      .not('image_cached_path', 'is', null)
    for (const r of data ?? []) imageSet.add(`${r.supplier_fortnox_number}|${r.article_number}`)
  }
  let withImage = 0
  for (const [pid, combo] of productCombos) if (imageSet.has(combo)) withImage++
  console.log(`Products with image_cached_path: ${withImage}`)
  console.log(`Effective thumb coverage: ${(100 * withImage / products.length).toFixed(1)}%`)
}

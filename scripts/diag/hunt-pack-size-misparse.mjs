// Find products where the "N st" in the name produced a pack_size > 1
// but the invoice unit_price implies per-PIECE pricing (so dividing by
// pack_size gives nonsensically small per-piece cost — what made Avocado
// Hass 24st CO render as 0 kr on recipes).
//
// Heuristic: cost_per_base_unit = latest_unit_price / pack_size.
// If pack_size > 1 AND cost_per_base_unit < 2 SEK, flag — most real
// kitchen ingredients cost more than 2 kr/piece. Specifically catches
// the Avocado pattern (9 kr / 24 = 0.375).
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]
const FLOOR_KR = 2 // per-piece cost we'd expect at minimum (realistic for ingredients)

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  let from = 0
  const prods = []
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, pack_size, base_unit, invoice_unit, pack_source')
      .eq('business_id', biz.id).is('archived_at', null)
      .gt('pack_size', 1).eq('base_unit', 'st')
      .order('id').range(from, from + 999)
    if (!data?.length) break
    prods.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  Products with pack_size>1 base_unit=st: ${prods.length}`)

  const productIds = prods.map(p => p.id)
  const aliasesByProduct = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('product_aliases').select('id, product_id').in('product_id', slice).eq('is_active', true)
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id); aliasesByProduct.set(a.product_id, arr)
    }
  }
  const allAliasIds = [...aliasesByProduct.values()].flat()
  const aliasToProduct = new Map()
  for (const [pid, ids] of aliasesByProduct) for (const aid of ids) aliasToProduct.set(aid, pid)
  if (allAliasIds.length === 0) { console.log(`  No active aliases on these products.`); continue }

  const latestByProduct = new Map() // pid -> { unit_price, line_total, qty, invoice_unit, date }
  for (let i = 0; i < allAliasIds.length; i += 100) {
    const slice = allAliasIds.slice(i, i + 100)
    const { data } = await db.from('supplier_invoice_lines')
      .select('product_alias_id, price_per_unit, unit_price, line_total_excl_vat, line_total_excl_vat_sek, quantity, invoice_unit, invoice_date, description')
      .in('product_alias_id', slice).eq('match_status', 'matched')
      .order('invoice_date', { ascending: false }).limit(1000)
    for (const l of data ?? []) {
      const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
      if (!latestByProduct.has(pid)) latestByProduct.set(pid, l)
    }
  }

  const flagged = []
  for (const p of prods) {
    const l = latestByProduct.get(p.id); if (!l) continue
    const ppu = Number(l.price_per_unit ?? l.unit_price ?? 0)
    if (!Number.isFinite(ppu) || ppu <= 0) continue
    const costPerPiece = ppu / Number(p.pack_size)
    if (costPerPiece < FLOOR_KR) {
      flagged.push({ ...p, ppu, costPerPiece, qty: l.quantity, inv_unit: l.invoice_unit, desc: l.description })
    }
  }
  flagged.sort((a, b) => a.costPerPiece - b.costPerPiece)
  console.log(`  Suspect (cost/piece < ${FLOOR_KR} SEK): ${flagged.length}`)

  console.log(`  By pack_source:`)
  const bySource = new Map()
  for (const f of flagged) bySource.set(f.pack_source, (bySource.get(f.pack_source) ?? 0) + 1)
  for (const [s, n] of [...bySource.entries()].sort((a,b) => b[1] - a[1])) console.log(`    ${s ?? '∅'}: ${n}`)

  console.log(`\n  Top 30 worst (lowest implied per-piece cost):`)
  for (const f of flagged.slice(0, 30)) {
    console.log(`    pack=${f.pack_size} ppu=${f.ppu.toFixed(2)} per-piece=${f.costPerPiece.toFixed(3)}  src=${f.pack_source}  "${f.name?.slice(0,40)}"`)
    console.log(`        inv: qty=${f.qty} unit=${f.inv_unit}  "${f.desc?.slice(0,50)}"`)
  }
}

// Smoke-test analyse_avtal_candidates against Vero's invoice history.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')]
  })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Inline the tool logic (mirrors lib/ai/tools/inventory.ts analyse_avtal_candidates)
const ctx = { db, orgId: 'e917d4b8-635e-4be6-8af0-afc48c3c7450', businessId: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' }
const args = { supplier_filter: 'martin servera', months_back: 12, min_invoices: 3, top_n: 10 }

const supplierFilter = args.supplier_filter?.trim().toLowerCase() ?? null
const monthsBack = Math.min(24, Math.max(1, args.months_back ?? 12))
const minInvoices = Math.max(1, args.min_invoices ?? 3)
const topN = Math.min(50, Math.max(1, args.top_n ?? 20))
const cutoff = new Date(Date.now() - monthsBack * 30 * 86400_000).toISOString().slice(0, 10)

let q = ctx.db.from('supplier_invoice_lines')
  .select('product_alias_id, supplier_name_snapshot, supplier_fortnox_number, quantity, total_excl_vat, price_per_unit, invoice_date, fortnox_invoice_number')
  .eq('business_id', ctx.businessId).not('product_alias_id', 'is', null).gte('invoice_date', cutoff)
if (supplierFilter) q = q.ilike('supplier_name_snapshot', `%${supplierFilter}%`)
const { data: lines, error } = await q.range(0, 49_999)
if (error) { console.error('ERR:', error.message); process.exit(1) }
console.log('lines pulled:', lines.length, 'since', cutoff)

const aliasIds = Array.from(new Set(lines.map(l => l.product_alias_id).filter(Boolean)))
const aliasToProduct = new Map()
for (let i = 0; i < aliasIds.length; i += 100) {
  const { data } = await db.from('product_aliases').select('id, product_id').in('id', aliasIds.slice(i, i+100))
  for (const a of data ?? []) aliasToProduct.set(a.id, a.product_id)
}
const productIds = Array.from(new Set(aliasToProduct.values()))
const productById = new Map()
for (let i = 0; i < productIds.length; i += 100) {
  const { data } = await db.from('products').select('id, name, category, default_supplier_name, invoice_unit').in('id', productIds.slice(i, i+100))
  for (const p of data ?? []) productById.set(p.id, p)
}

const agg = new Map()
for (const l of lines) {
  const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
  const prod = productById.get(pid); if (!prod) continue
  let row = agg.get(pid)
  if (!row) {
    row = { product_id: pid, name: prod.name, category: prod.category, supplier: prod.default_supplier_name ?? l.supplier_name_snapshot, invoice_unit: prod.invoice_unit,
            total_spend: 0, line_count: 0, invoice_numbers: new Set(), months: new Set(), suppliers: new Set(), pricePoints: [] }
    agg.set(pid, row)
  }
  const spend = l.total_excl_vat != null ? Number(l.total_excl_vat) : (l.price_per_unit && l.quantity ? l.price_per_unit * l.quantity : 0)
  row.total_spend += Number.isFinite(spend) ? spend : 0
  row.line_count++
  if (l.fortnox_invoice_number) row.invoice_numbers.add(String(l.fortnox_invoice_number))
  if (l.supplier_fortnox_number) row.suppliers.add(String(l.supplier_fortnox_number))
  if (l.invoice_date) row.months.add(String(l.invoice_date).slice(0, 7))
  if (l.price_per_unit != null && l.invoice_date) row.pricePoints.push({ date: l.invoice_date, unit_price: Number(l.price_per_unit) })
}

function score(a) {
  const points = a.pricePoints.sort((x, y) => x.date.localeCompare(y.date))
  const prices = points.map(p => p.unit_price)
  const mean = prices.length ? prices.reduce((s, x) => s + x, 0) / prices.length : 0
  const variance = prices.length > 1 ? prices.reduce((s, x) => s + (x - mean) ** 2, 0) / (prices.length - 1) : 0
  const stdev = Math.sqrt(variance)
  const volatilityPct = mean > 0 ? (stdev / mean) * 100 : 0
  let trendPct = 0
  if (points.length >= 4) {
    const qsize = Math.max(1, Math.floor(points.length / 4))
    const head = prices.slice(0, qsize).reduce((s, x) => s + x, 0) / qsize
    const tail = prices.slice(-qsize).reduce((s, x) => s + x, 0) / qsize
    if (head > 0) trendPct = ((tail - head) / head) * 100
  }
  const monthsCovered = a.months.size
  const consistency = Math.min(1, monthsCovered / monthsBack)
  const volBonus = Math.min(0.75, volatilityPct / 50 * 0.75)
  const trendBonus = Math.max(0, Math.min(0.5, trendPct / 20 * 0.5))
  const multiSupBonus = a.suppliers.size >= 2 ? 0.25 : 0
  const s = Math.log10(a.total_spend + 1) * (0.5 + consistency) * (1 + volBonus + trendBonus + multiSupBonus)
  const reasons = []
  if (a.total_spend >= 50_000) reasons.push(`Large spend: SEK ${Math.round(a.total_spend).toLocaleString('sv-SE')} over ${monthsCovered}m`)
  else if (a.total_spend >= 10_000) reasons.push(`Mid spend: SEK ${Math.round(a.total_spend).toLocaleString('sv-SE')}`)
  if (consistency >= 0.8) reasons.push(`Every month — predictable demand`)
  else if (consistency >= 0.5) reasons.push(`Bought ${monthsCovered}/${monthsBack} months`)
  if (volatilityPct >= 15) reasons.push(`Price varies ±${volatilityPct.toFixed(0)}% — locking saves`)
  if (trendPct >= 8) reasons.push(`Trending up ${trendPct.toFixed(0)}%`)
  if (a.suppliers.size >= 2) reasons.push(`From ${a.suppliers.size} suppliers — consolidate`)
  return { name: a.name, supplier_count: a.suppliers.size, total_spend: Math.round(a.total_spend), invoice_count: a.invoice_numbers.size, months_covered: monthsCovered, vol: volatilityPct.toFixed(1)+'%', trend: trendPct.toFixed(1)+'%', score: s.toFixed(2), why: reasons }
}

const qualifying = Array.from(agg.values()).filter(a => a.invoice_numbers.size >= minInvoices)
const ranked = qualifying.map(score).sort((a, b) => Number(b.score) - Number(a.score)).slice(0, topN)
console.log(`products analysed: ${agg.size}, qualifying: ${qualifying.length}`)
console.log('\nTop avtal candidates @ Martin Servera (Vero, last 12mo):\n')
for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i]
  console.log(`${(i+1).toString().padStart(2)} [${r.score}] ${r.name.slice(0, 45).padEnd(45)} | SEK ${r.total_spend.toLocaleString('sv-SE').padStart(10)} | ${r.invoice_count.toString().padStart(3)} inv | ${r.months_covered}mo | vol ${r.vol.padStart(6)} | trend ${r.trend.padStart(7)}`)
  for (const w of r.why) console.log(`     · ${w}`)
}

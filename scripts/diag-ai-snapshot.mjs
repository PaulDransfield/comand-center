import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

// We can't easily import TS in node — replicate the snapshot logic inline.
// Just run the same queries and print what the snapshot WOULD look like.

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const sec = (s) => `\n${s}`

const { data: biz } = await db.from('businesses')
  .select('name, legal_name, legal_city, org_number, country, vat_filing_cadence, setup_health_summary, setup_health_updated_at')
  .eq('id', bizId).maybeSingle()
console.log('=== BUSINESS STATE (cache-derived, current as of this request) ===')
if (biz) {
  const disp = biz.legal_name && biz.legal_name !== biz.name ? `${biz.legal_name} (trades as ${biz.name})` : (biz.legal_name ?? biz.name)
  console.log(`Business:        ${disp} · ${biz.org_number} · ${biz.legal_city} · ${biz.country}`)
  console.log(`VAT cadence:     ${biz.vat_filing_cadence ?? 'not set'}`)
  const hs = biz.setup_health_summary
  if (hs?.counts) {
    const c = hs.counts
    const total = (c.ok ?? 0) + (c.warn ?? 0) + (c.fail ?? 0) + (c.pending ?? 0)
    const failing = (hs.failing_checks ?? []).map(f => f.label).slice(0, 3).join(', ')
    console.log(`Setup health:    ${c.ok ?? 0}/${total} ok · overall=${hs.overall}`)
    if (failing) console.log(`                 Pending/issues: ${failing}`)
  }
}

const { data: alRow } = await db.from('overhead_drilldown_cache')
  .select('payload, fetched_at').eq('business_id', bizId).eq('period_month', 0)
  .like('category', '__accounts_list_fy%').order('fetched_at', { ascending: false }).limit(1).maybeSingle()
if (alRow) {
  console.log(`Fiscal year:     ${alRow.payload.fiscal_year_from} → ${alRow.payload.fiscal_year_to}`)
  console.log(`Account chart:   ${alRow.payload.total_accounts} accounts`)
}

const { count: vc } = await db.from('fortnox_vouchers_cache').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { data: latestV } = await db.from('fortnox_vouchers_cache').select('transaction_date').eq('business_id', bizId).order('transaction_date', { ascending: false }).limit(1).maybeSingle()
console.log(`Books freshness: latest ${latestV?.transaction_date} · ${vc} vouchers cached`)

const { data: bbRows } = await db.from('overhead_drilldown_cache').select('payload, fetched_at, category').eq('business_id', bizId).eq('period_month', 0).like('category', '__bank_balance_v2_%').order('fetched_at', { ascending: false })
let sum = 0, count = 0, largestVal = 0, largestAcc = 0
const seen = new Set()
for (const r of bbRows ?? []) {
  const p = r.payload
  if (!p || typeof p.account !== 'number') continue
  if (seen.has(p.account)) continue
  seen.add(p.account)
  if (p.account < 1900 || p.account > 1989) continue
  const cur = Number(p.current_balance ?? 0)
  sum += cur; count++
  if (Math.abs(cur) > Math.abs(largestVal)) { largestVal = cur; largestAcc = p.account }
}
console.log(`Cash position:   ${Math.round(sum).toLocaleString('sv-SE')} kr (${count} accounts in 1900-1989)`)
console.log(`                 Largest: ${largestAcc} = ${Math.round(largestVal).toLocaleString('sv-SE')} kr`)

const { count: closedCount } = await db.from('tracker_data').select('*', { count: 'exact', head: true }).eq('business_id', bizId).or('is_provisional.is.null,is_provisional.eq.false')
const { data: latestT } = await db.from('tracker_data').select('period_year, period_month, revenue, net_profit, margin_pct').eq('business_id', bizId).or('is_provisional.is.null,is_provisional.eq.false').order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(1).maybeSingle()
console.log(`Closed P&L:      ${closedCount} months · latest ${latestT?.period_year}-${String(latestT?.period_month).padStart(2,'0')} rev=${Math.round(latestT?.revenue ?? 0).toLocaleString('sv-SE')} kr net=${Math.round(latestT?.net_profit ?? 0).toLocaleString('sv-SE')} kr margin=${latestT?.margin_pct?.toFixed(1)}%`)

const { count: pc } = await db.from('products').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { count: ac } = await db.from('product_aliases').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { count: lc } = await db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).eq('business_id', bizId)
const { data: exr } = await db.from('invoice_pdf_extractions').select('status').eq('business_id', bizId).range(0, 9999)
const sc = {}
for (const r of exr ?? []) sc[r.status] = (sc[r.status] ?? 0) + 1
const totalExt = Object.values(sc).reduce((s, n) => s + n, 0)
console.log(`Inventory:       ${pc} products · ${ac} aliases · ${lc} supplier-invoice lines`)
console.log(`                 PDF extractions: ${sc.extracted ?? 0}/${totalExt} done · ${sc.pending ?? 0} pending`)
console.log('=== END BUSINESS STATE ===')

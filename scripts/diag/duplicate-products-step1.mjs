// Duplicate products — Step 1 fragmentation sizing.
//
// Clusters products that plausibly represent the same real-world item.
// Two complementary heuristics, intersected:
//
//   A. SHARED ARTICLE CODE: products whose aliases point at supplier
//      invoice lines that share a supplier_fortnox_number +
//      article_number. Strong signal — same supplier, same SKU code.
//
//   B. NORMALISED-NAME MATCH: collapse case, strip pack tokens (kg/g/
//      ml/l/eg/cl/dl/st/x), strip parentheticals, strip "FRYST"/"EKO"
//      suffixes (those are distinguishing — group separately), sort
//      remaining tokens alphabetically. Products that normalise to the
//      same root land in the same cluster.
//
// Then per cluster: pack-format severity tier.
//   CLEAN  — all members have the same pack_size + base_unit (or
//            same pack token in name); merges trivially
//   AMBIG  — pack formats differ ("3x100g" vs "125g"); manual decision
//
// READ-ONLY. Outputs JSON snapshot + Markdown summary for the deliverable.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

// Strip pack/format tokens to get the bare product root. Pack info like
// "125g", "3x100", "PET 5L" varies between fragments — we want to find
// the underlying item name. Keep distinguishing modifiers (FRYST/EKO).
function normalisedRoot(name) {
  if (!name) return ''
  let s = String(name).toLowerCase().normalize('NFKD')
  // Remove parentheticals + supplier codes like "(21451)" "SC RB SE"
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\b(sc|rb|se|kl1|st|stk)\b/g, ' ')
  // Strip pack tokens
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr|gram|ml|cl|dl|l|liter|litre|eg|st|stk)?\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|lt|lf|eg|st|stk|burk|flaska|paket|pkt|frp|fp|pack)\b/g, ' ')
  // Drop punctuation
  s = s.replace(/[^\p{Letter}\s]/gu, ' ')
  // Collapse whitespace
  const tokens = s.split(/\s+/).filter(t => t.length >= 3)
  // FRYST / EKO are distinguishing — keep but normalise.
  const distinguishing = new Set()
  for (const t of tokens) {
    if (t === 'frys' || t === 'fryst') distinguishing.add('@frozen')
    if (t === 'eko' || t === 'ekologisk') distinguishing.add('@organic')
    if (t === 'pet') distinguishing.add('@pet')
  }
  const core = tokens
    .filter(t => !['frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan'].includes(t))
    .sort()
  return [...core, ...[...distinguishing].sort()].join(' ')
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. ALL active products
  const products = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, category, invoice_unit, pack_size, base_unit, default_supplier_name, default_supplier_fortnox_number')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  console.log(`  active products: ${products.length}`)

  // 2. Cluster by normalised root.
  const clusters = new Map()
  for (const p of products) {
    const root = normalisedRoot(p.name)
    if (!root) continue
    const arr = clusters.get(root) ?? []
    arr.push(p); clusters.set(root, arr)
  }
  const dupClusters = [...clusters.entries()].filter(([, arr]) => arr.length >= 2)
  console.log(`  duplicate clusters (≥2 products with same name root): ${dupClusters.length}`)
  const totalDupProducts = dupClusters.reduce((s, [, arr]) => s + arr.length, 0)
  const potentiallyCollapsableTo = dupClusters.length   // 1 canonical per cluster
  console.log(`  total products in duplicate clusters: ${totalDupProducts}`)
  console.log(`  potential collapse: ${totalDupProducts} → ${potentiallyCollapsableTo} (frees ${totalDupProducts - potentiallyCollapsableTo} product rows)`)

  // 3. Severity tier per cluster. CLEAN if all members have same pack_size+base_unit.
  let clean = 0, ambig = 0
  const cleanClusters = []
  const ambigClusters = []
  for (const [root, arr] of dupClusters) {
    const packs = new Set(arr.map(p => `${p.pack_size ?? '∅'}${p.base_unit ?? '∅'}`))
    if (packs.size === 1) { clean++; cleanClusters.push({ root, arr }) }
    else { ambig++; ambigClusters.push({ root, arr, packs: [...packs] }) }
  }
  console.log(`    CLEAN clusters (same pack across members): ${clean}`)
  console.log(`    AMBIG clusters (different pack formats):    ${ambig}`)

  // 4. Per-supplier concentration of duplicates.
  const supplierClusterCount = new Map()
  for (const [, arr] of dupClusters) {
    for (const p of arr) {
      const s = p.default_supplier_name ?? '∅'
      supplierClusterCount.set(s, (supplierClusterCount.get(s) ?? 0) + 1)
    }
  }
  const top = [...supplierClusterCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  console.log(`\n  Top 10 suppliers by duplicate-cluster product count:`)
  for (const [s, n] of top) console.log(`    ${n.toString().padStart(4)} × ${s}`)

  // 5. Sample 15 of each tier.
  console.log(`\n  CLEAN cluster samples (first 15):`)
  for (const { root, arr } of cleanClusters.slice(0, 15)) {
    console.log(`    [${arr.length}× ${arr[0].pack_size ?? '∅'}${arr[0].base_unit ?? '∅'}] root="${root}"`)
    for (const p of arr) console.log(`      - "${p.name}"`)
  }
  console.log(`\n  AMBIG cluster samples (first 8):`)
  for (const { root, arr, packs } of ambigClusters.slice(0, 8)) {
    console.log(`    [${arr.length}× DIFFERENT PACKS: ${packs.join(', ')}] root="${root}"`)
    for (const p of arr) console.log(`      - "${p.name}"  (pack=${p.pack_size ?? '∅'} ${p.base_unit ?? '∅'})`)
  }

  // 6. Persist snapshot for the doc deliverable.
  const snapshotPath = `docs/investigation/duplicate-products-${biz.name.toLowerCase()}-snapshot.json`
  fs.mkdirSync('docs/investigation', { recursive: true })
  fs.writeFileSync(snapshotPath, JSON.stringify({
    business:         biz.name,
    captured_at:      new Date().toISOString(),
    active_products:  products.length,
    duplicate_clusters: dupClusters.length,
    products_in_clusters: totalDupProducts,
    potential_collapse_savings: totalDupProducts - potentiallyCollapsableTo,
    clean_clusters:   clean,
    ambig_clusters:   ambig,
    top_suppliers:    top,
    clean_samples:    cleanClusters.slice(0, 30).map(c => ({ root: c.root, names: c.arr.map(p => p.name) })),
    ambig_samples:    ambigClusters.slice(0, 30).map(c => ({ root: c.root, packs: c.packs, names: c.arr.map(p => `${p.name} (${p.pack_size ?? '∅'} ${p.base_unit ?? '∅'})`) })),
  }, null, 2))
  console.log(`\n  snapshot → ${snapshotPath}`)
}

console.log('\ndone')

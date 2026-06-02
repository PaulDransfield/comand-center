// CLEAN-clusters dedup — Step 3.2.
//
// For each CLEAN cluster (same pack_size + base_unit across members):
//   1. Pick the canonical: most-recent supplier line activity, fall
//      back to highest alias count, fall back to lowest id.
//   2. LLM verifies the cluster members ARE the same SKU (one batch
//      call covers many clusters). Confidence floor 0.92.
//   3. For each non-canonical member:
//      - Repoint all its product_aliases onto the canonical.
//      - Update any recipe_ingredients pointing at it to point at canonical.
//      - Archive the now-empty product (archived_at = NOW()).
//
// All UPDATEs are reversible; nothing hard-deleted. Repoint endpoint
// design (M089) means the cost engine follows the new pointer on next
// render — no cascade, no recompute needed.
//
// Usage:
//   node scripts/diag/clean-clusters-dedup.mjs           # DRY
//   node scripts/diag/clean-clusters-dedup.mjs --apply

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY
if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1) }

const APPLY = process.argv.includes('--apply')
const MODEL = 'claude-haiku-4-5-20251001'
const CONF_FLOOR = 0.92

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

function normalisedRoot(name) {
  if (!name) return ''
  let s = String(name).toLowerCase().normalize('NFKD')
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\b(sc|rb|se|kl1|st|stk)\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr|gram|ml|cl|dl|l|liter|litre|eg|st|stk)?\b/g, ' ')
  s = s.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|lt|lf|eg|st|stk|burk|flaska|paket|pkt|frp|fp|pack)\b/g, ' ')
  s = s.replace(/[^\p{Letter}\s]/gu, ' ')
  const toks = s.split(/\s+/).filter(t => t.length >= 3)
  const dist = new Set()
  for (const t of toks) {
    if (t === 'frys' || t === 'fryst') dist.add('@frozen')
    if (t === 'eko' || t === 'ekologisk') dist.add('@organic')
    if (t === 'pet') dist.add('@pet')
  }
  const core = toks
    .filter(t => !['frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan'].includes(t))
    .sort()
  return [...core, ...[...dist].sort()].join(' ')
}

const SYSTEM_PROMPT = `You verify duplicate-product clusters in a restaurant catalogue. Each cluster contains 2+ products that share the same normalised name root AND the same pack format (pack_size + base_unit identical). You must rule whether they ARE the same real-world item (just different invoice-description variants) or DIFFERENT items that happen to cluster.

CLUSTERS ARE THE SAME REAL-WORLD ITEM when members differ only by:
  - Letter case / spacing
  - Word order ("Panko Ströbröd" vs "Ströbröd Panko")
  - Trailing supplier codes (SC, RB, SE, ES, country origin codes)
  - Trailing parentheticals like "(12/fp)", "(15kg)", "(21451)"
  - "DG" Dagens Goda prefix

CLUSTERS ARE DIFFERENT (set verdict='different') when:
  - Fat percentages differ ("Mascarpone 47%" vs "Mascarpone 48%" — strictly different, even if interchangeable in recipes — owner judgment)
  - Grade indicators differ ("Paprika 70+" vs "Paprika 141+")
  - Brand differs and isn't obviously the same line
  - Anything that looks like a different SKU even with same pack

EXAMPLES (cluster name first, then members):

  burrata (2× 125g)
    - "Burrata 125g"
    - "Burrata DG 125g"
    → verdict='same', confidence=0.95

  mascarpone (4× 2000g)
    - "Mascarpone 2 kg"
    - "Mascarpone 2kg"
    - "Mascarpone 48% 2kg"
    - "Mascarpone 47% 2kg"
    → verdict='different', confidence=0.92, reasoning='Two of the four specify 47% vs 48% fat — strictly distinct SKUs.'

OUTPUT: Return ONLY valid JSON (no markdown, no commentary):

{
  "items": [
    { "cluster_id": "<id>", "verdict": "same|different|uncertain", "confidence": <0.0-1.0>, "reasoning": "<1 short sentence>" }
  ]
}

Include every cluster_id from the input.`

async function callHaiku(clusters) {
  // clusters: [{ cluster_id, root, pack_label, members: [{ id, name }] }]
  const lines = clusters.map(c => {
    const members = c.members.map(m => `    - "${m.name}"`).join('\n')
    return `cluster_id=${c.cluster_id} (root="${c.root}", pack=${c.pack_label}, ${c.members.length} members):\n${members}`
  }).join('\n\n')
  const userMsg = `Verify whether each cluster represents the same real-world SKU:\n\n${lines}`

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }] }),
  })
  if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` }
  const j = await r.json()
  const text = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON', raw: text.slice(0, 500) }
  let parsed
  try { parsed = JSON.parse(text.slice(start, end + 1)) }
  catch (e) { return { ok: false, error: `JSON: ${e.message}`, raw: text.slice(0, 500) } }
  return { ok: true, items: parsed.items ?? [], tokensIn: j.usage?.input_tokens ?? 0, tokensOut: j.usage?.output_tokens ?? 0 }
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)

  // 1. ALL active products
  const products = []
  let from = 0
  while (true) {
    const { data, error } = await db.from('products')
      .select('id, name, category, invoice_unit, pack_size, base_unit, default_supplier_name, updated_at')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  // 2. Cluster + filter to CLEAN (same pack_size + base_unit).
  const clusters = new Map()
  for (const p of products) {
    const root = normalisedRoot(p.name)
    if (!root) continue
    const arr = clusters.get(root) ?? []
    arr.push(p); clusters.set(root, arr)
  }
  const cleanClusters = []
  for (const [root, arr] of clusters) {
    if (arr.length < 2) continue
    const packs = new Set(arr.map(p => `${p.pack_size ?? '∅'}|${p.base_unit ?? '∅'}`))
    if (packs.size !== 1) continue
    cleanClusters.push({
      cluster_id: root.slice(0, 60) + ':' + arr.length,   // human-readable handle
      root,
      pack_label: `${arr[0].pack_size ?? '∅'} ${arr[0].base_unit ?? '∅'}`,
      members: arr,
    })
  }
  console.log(`  CLEAN clusters: ${cleanClusters.length}`)
  if (cleanClusters.length === 0) continue

  // 3. Per-product enrichment — alias count + most-recent line date.
  // We need these to pick the canonical member.
  const allMemberIds = cleanClusters.flatMap(c => c.members.map(m => m.id))
  const aliasesByProduct = new Map()
  for (let i = 0; i < allMemberIds.length; i += 100) {
    const slice = allMemberIds.slice(i, i + 100)
    const { data } = await db.from('product_aliases').select('id, product_id').in('product_id', slice)
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id); aliasesByProduct.set(a.product_id, arr)
    }
  }
  const allAliasIds = [...new Set([...aliasesByProduct.values()].flat())]
  const aliasToProduct = new Map()
  for (const [pid, aids] of aliasesByProduct) for (const a of aids) aliasToProduct.set(a, pid)
  const productLatestLine = new Map()   // product_id → latest invoice_date
  for (let i = 0; i < allAliasIds.length; i += 100) {
    const slice = allAliasIds.slice(i, i + 100)
    // Paginate within each slice — supabase caps at 1000/req.
    let lfrom = 0
    while (lfrom < 10000) {
      const { data } = await db.from('supplier_invoice_lines')
        .select('product_alias_id, invoice_date')
        .eq('business_id', biz.id)
        .eq('match_status', 'matched')
        .in('product_alias_id', slice)
        .order('invoice_date', { ascending: false })
        .range(lfrom, lfrom + 999)
      if (!data || data.length === 0) break
      for (const l of data) {
        const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
        const cur = productLatestLine.get(pid)
        if (!cur || l.invoice_date > cur) productLatestLine.set(pid, l.invoice_date)
      }
      if (data.length < 1000) break
      lfrom += 1000
    }
  }

  // 4. Recipe references per product.
  const recipeIds = []
  let rfrom = 0
  while (true) {
    const { data } = await db.from('recipes').select('id').eq('business_id', biz.id).order('id').range(rfrom, rfrom + 999)
    if (!data || data.length === 0) break
    for (const r of data) recipeIds.push(r.id)
    if (data.length < 1000) break
    rfrom += 1000
  }
  const recipeRefsByProduct = new Map()  // product_id → [ingredient_ids]
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data } = await db.from('recipe_ingredients').select('id, product_id').in('recipe_id', slice).not('product_id', 'is', null)
    for (const ri of data ?? []) {
      const arr = recipeRefsByProduct.get(ri.product_id) ?? []
      arr.push(ri.id); recipeRefsByProduct.set(ri.product_id, arr)
    }
  }

  // 5. Pick canonical per cluster: priority = (most-recent line date),
  // then (highest alias count), then (lowest id deterministic tiebreak).
  for (const c of cleanClusters) {
    c.members.sort((a, b) => {
      const da = productLatestLine.get(a.id) ?? ''
      const dbb = productLatestLine.get(b.id) ?? ''
      if (da !== dbb) return dbb.localeCompare(da)   // desc by date
      const aa = (aliasesByProduct.get(a.id) ?? []).length
      const bb = (aliasesByProduct.get(b.id) ?? []).length
      if (aa !== bb) return bb - aa                  // desc by alias count
      return a.id.localeCompare(b.id)                // deterministic
    })
    c.canonical = c.members[0]
    c.others    = c.members.slice(1)
  }

  // 6. LLM verification — batch in groups of 20 clusters per call.
  let totalIn = 0, totalOut = 0
  const verdicts = new Map()
  const BATCH = 20
  for (let i = 0; i < cleanClusters.length; i += BATCH) {
    const batch = cleanClusters.slice(i, i + BATCH)
    process.stdout.write(`  LLM batch ${Math.floor(i/BATCH)+1}/${Math.ceil(cleanClusters.length/BATCH)} (${batch.length} clusters)…`)
    const r = await callHaiku(batch.map(c => ({ cluster_id: c.cluster_id, root: c.root, pack_label: c.pack_label, members: c.members })))
    if (!r.ok) { console.log(` FAILED: ${r.error}`); continue }
    totalIn += r.tokensIn; totalOut += r.tokensOut
    for (const it of r.items) verdicts.set(String(it.cluster_id ?? ''), { verdict: String(it.verdict ?? ''), conf: Number(it.confidence), rsn: String(it.reasoning ?? '').slice(0, 200) })
    console.log(' done')
  }
  console.log(`  Tokens: in=${totalIn} out=${totalOut} (~$${(totalIn * 0.000001 + totalOut * 0.000005).toFixed(4)})`)

  // 7. Bucket clusters by verdict.
  const approved = []
  const flagged  = []
  const skipped  = []
  for (const c of cleanClusters) {
    const v = verdicts.get(c.cluster_id)
    if (!v) { skipped.push({ c, why: 'no verdict' }); continue }
    if (v.verdict !== 'same' || !Number.isFinite(v.conf) || v.conf < CONF_FLOOR) {
      skipped.push({ c, why: `${v.verdict} conf=${v.conf} (${v.rsn})` }); continue
    }
    approved.push({ c, v })
  }
  console.log(`\n  Approved: ${approved.length}  Skipped: ${skipped.length}`)

  // 8. For each approved cluster — count what will change.
  let totalAliasRepoints = 0
  let totalIngredientUpdates = 0
  let totalProductArchives  = 0
  for (const { c, v } of approved) {
    let aliases = 0, ingredients = 0, archives = 0
    for (const o of c.others) {
      aliases     += (aliasesByProduct.get(o.id) ?? []).length
      ingredients += (recipeRefsByProduct.get(o.id) ?? []).length
      archives    += 1
    }
    c.changeCount = { aliases, ingredients, archives }
    totalAliasRepoints     += aliases
    totalIngredientUpdates += ingredients
    totalProductArchives   += archives
  }
  console.log(`  Will repoint ${totalAliasRepoints} aliases, update ${totalIngredientUpdates} recipe_ingredients, archive ${totalProductArchives} duplicate products`)

  // 9. Sample of approved + skipped.
  console.log(`\n  Approved sample (first 10):`)
  for (const { c, v } of approved.slice(0, 10)) {
    console.log(`    ✓ root="${c.root}" pack=${c.pack_label}  [${c.members.length} members → 1 canonical "${c.canonical.name}"]`)
    console.log(`        reasoning: ${v.rsn}  (conf ${v.conf.toFixed(2)})`)
    for (const o of c.others) console.log(`        - "${o.name}" → archive (aliases=${c.changeCount?.aliases ?? '?'}, recipe_refs=${(recipeRefsByProduct.get(o.id) ?? []).length})`)
  }
  if (skipped.length > 0) {
    console.log(`\n  Skipped sample (first 10):`)
    for (const { c, why } of skipped.slice(0, 10)) {
      console.log(`    ✗ root="${c.root}" pack=${c.pack_label}  (${why})`)
      for (const m of c.members) console.log(`        - "${m.name}"`)
    }
  }

  // 10. APPLY — for each approved cluster, do the work.
  if (APPLY && approved.length > 0) {
    console.log(`\n  APPLYING ${approved.length} cluster collapses…`)
    let okClusters = 0, errClusters = 0
    for (const { c } of approved) {
      try {
        for (const o of c.others) {
          // Repoint all this other-product's aliases onto canonical.
          const aliasIds = aliasesByProduct.get(o.id) ?? []
          if (aliasIds.length > 0) {
            for (let i = 0; i < aliasIds.length; i += 100) {
              const slice = aliasIds.slice(i, i + 100)
              const { error } = await db.from('product_aliases').update({ product_id: c.canonical.id }).in('id', slice)
              if (error) throw new Error(`alias repoint: ${error.message}`)
            }
          }
          // Update recipe_ingredients pointing at this other product.
          const ingIds = recipeRefsByProduct.get(o.id) ?? []
          if (ingIds.length > 0) {
            for (let i = 0; i < ingIds.length; i += 100) {
              const slice = ingIds.slice(i, i + 100)
              const { error } = await db.from('recipe_ingredients').update({ product_id: c.canonical.id }).in('id', slice)
              if (error) throw new Error(`recipe_ingredient update: ${error.message}`)
            }
          }
          // Archive the now-empty product.
          const { error: aErr } = await db.from('products').update({ archived_at: new Date().toISOString() }).eq('id', o.id)
          if (aErr) throw new Error(`archive: ${aErr.message}`)
        }
        okClusters++
      } catch (e) {
        console.error(`    cluster "${c.root}" failed: ${e.message}`)
        errClusters++
      }
    }
    console.log(`  Collapsed: ${okClusters} clusters  (errors: ${errClusters})`)
  } else if (approved.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')

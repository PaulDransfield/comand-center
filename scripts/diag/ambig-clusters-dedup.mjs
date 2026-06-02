// ambig-clusters-dedup.mjs
//
// AMBIG clusters = same normalised name root but DIFFERENT pack_size /
// base_unit across members. Two completely different sub-shapes:
//
//   SAME_SKU_PARSE_ERROR — members ARE the same supplier SKU, one or
//     more has wrong pack info (regex failed on truncated name like
//     "Bulgur 1k" → 1 st, while sibling "Bulgur 1kg" → 1000 g).
//     Safe to collapse: pick the canonical with correct pack, repoint
//     aliases + recipe_ingredients, archive others.
//
//   DIFFERENT_SKUS — supplier ships the same item in legitimately
//     different pack sizes / grades / origins (Lök Gul 12kg vs Lök
//     Gul 2kg; Paprika Röd 70+ vs 141+). DON'T merge — owner buys
//     them separately, prices differ.
//
//   UNCERTAIN — hold for owner.
//
// Haiku classifies each cluster. Confidence floor 0.92 for auto-merge.
//
// Usage:
//   node scripts/diag/ambig-clusters-dedup.mjs           # DRY
//   node scripts/diag/ambig-clusters-dedup.mjs --apply

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

const SYSTEM_PROMPT = `You're classifying AMBIGUOUS duplicate-product clusters in a restaurant catalogue. Each cluster contains 2+ products that share a normalised name root BUT differ in pack_size or base_unit. Your job: decide which of three buckets the cluster belongs to.

BUCKET A — SAME_SKU_PARSE_ERROR
  All members are the SAME supplier SKU. One or more has WRONG pack info because the name was truncated, typo'd, or the parser misread it.

  Telltales:
    - "Bulgur 1k" (parsed as 1 st) + "Bulgur 1kg" (parsed as 1000 g) → '1k' is shorthand for '1kg', same product
    - "Lime St" (parsed as 1 st) + "Lime 60st BR" (parsed as 60 st) → 'Lime St' is the same lime, pack just unknown
    - "Olivolja XV" + "Olivolja XV 5L" → same oil, one has the L pack
    - "Apelsin" + "Apelsin 1kg" → first has no pack info; same SKU

  Pick the member with the CORRECT pack as canonical.

BUCKET B — DIFFERENT_SKUS
  Members are genuinely different SKUs the supplier sells separately.

  Telltales:
    - "Strösocker 2kg" + "Strösocker 10kg" → supplier ships both; different SKUs (different orders/prices)
    - "Lök Gul 12kg" + "Lök Gul 2kg" → different pack formats, both legitimate
    - "Paprika Röd 70+ 5kg PL" + "Paprika Röd 141+ 5kg NL" → different grades (70+ vs 141+); different origins (Poland vs Netherlands)
    - "Spenat Baby 8x100g DK" + "Spenat Baby Tv 500g" → very different formats (case of 8 small bags vs single 500g)
    - "Burrata 125g" + "Burrata 3x100 gr" → different pack formats (single 125g vs 3-pack 100g)

BUCKET C — UNCERTAIN
  Use when telltales conflict or you genuinely can't tell. We'll leave it for the owner.

KEY PRINCIPLE: when pack sizes differ by a factor matching the case-multiplier in one name (e.g. 12kg vs 1kg with "12x1kg" in the name), it's USUALLY BUCKET B (single bottle/bag vs case). When pack sizes differ but one name is just truncated ("Bulgur 1k" vs "Bulgur 1kg"), it's USUALLY BUCKET A.

OUTPUT: Return ONLY valid JSON (no markdown, no commentary):

{
  "items": [
    {
      "cluster_id": "<id>",
      "verdict": "same_sku_parse_error|different_skus|uncertain",
      "confidence": <0.0-1.0>,
      "canonical_index": <0-based index of the member to keep, ONLY when verdict='same_sku_parse_error'; null otherwise>,
      "reasoning": "<1 short sentence>"
    }
  ]
}

Include every cluster_id.`

async function callHaiku(clusters) {
  const lines = clusters.map(c => {
    const members = c.members.map((m, i) => `    [${i}] "${m.name}" — pack=${m.pack_size ?? '∅'} ${m.base_unit ?? '∅'}`).join('\n')
    return `cluster_id=${c.cluster_id} (root="${c.root}", ${c.members.length} members):\n${members}`
  }).join('\n\n')
  const userMsg = `Classify each cluster:\n\n${lines}`

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
      .select('id, name, pack_size, base_unit, default_supplier_name')
      .eq('business_id', biz.id)
      .is('archived_at', null)
      .order('id').range(from, from + 999)
    if (error) { console.error(error.message); break }
    if (!data || data.length === 0) break
    products.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  // 2. Cluster + filter to AMBIG (different pack formats).
  const clusters = new Map()
  for (const p of products) {
    const root = normalisedRoot(p.name)
    if (!root) continue
    const arr = clusters.get(root) ?? []
    arr.push(p); clusters.set(root, arr)
  }
  const ambigClusters = []
  for (const [root, arr] of clusters) {
    if (arr.length < 2) continue
    const packs = new Set(arr.map(p => `${p.pack_size ?? '∅'}|${p.base_unit ?? '∅'}`))
    if (packs.size === 1) continue   // CLEAN — different script handles those
    ambigClusters.push({
      cluster_id: root.slice(0, 60) + ':' + arr.length,
      root,
      members: arr,
    })
  }
  console.log(`  AMBIG clusters: ${ambigClusters.length}`)
  if (ambigClusters.length === 0) continue

  // 3. Per-product enrichment for canonical-pick: alias count + latest line.
  const memberIds = ambigClusters.flatMap(c => c.members.map(m => m.id))
  const aliasesByProduct = new Map()
  for (let i = 0; i < memberIds.length; i += 100) {
    const slice = memberIds.slice(i, i + 100)
    const { data } = await db.from('product_aliases').select('id, product_id').in('product_id', slice)
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id); aliasesByProduct.set(a.product_id, arr)
    }
  }
  const allAliasIds = [...new Set([...aliasesByProduct.values()].flat())]
  const aliasToProduct = new Map()
  for (const [pid, aids] of aliasesByProduct) for (const a of aids) aliasToProduct.set(a, pid)
  const productLatestLine = new Map()
  for (let i = 0; i < allAliasIds.length; i += 100) {
    const slice = allAliasIds.slice(i, i + 100)
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
  const recipeRefsByProduct = new Map()
  for (let i = 0; i < recipeIds.length; i += 100) {
    const slice = recipeIds.slice(i, i + 100)
    const { data } = await db.from('recipe_ingredients').select('id, product_id').in('recipe_id', slice).not('product_id', 'is', null)
    for (const ri of data ?? []) {
      const arr = recipeRefsByProduct.get(ri.product_id) ?? []
      arr.push(ri.id); recipeRefsByProduct.set(ri.product_id, arr)
    }
  }

  // 5. LLM batch — 15 clusters per call (AMBIG has more text per cluster).
  let totalIn = 0, totalOut = 0
  const verdicts = new Map()
  const BATCH = 15
  for (let i = 0; i < ambigClusters.length; i += BATCH) {
    const batch = ambigClusters.slice(i, i + BATCH)
    process.stdout.write(`  LLM batch ${Math.floor(i/BATCH)+1}/${Math.ceil(ambigClusters.length/BATCH)} (${batch.length} clusters)…`)
    const r = await callHaiku(batch)
    if (!r.ok) { console.log(` FAILED: ${r.error}`); continue }
    totalIn += r.tokensIn; totalOut += r.tokensOut
    for (const it of r.items) {
      verdicts.set(String(it.cluster_id ?? ''), {
        verdict: String(it.verdict ?? ''),
        canonical_index: it.canonical_index,
        conf: Number(it.confidence),
        rsn: String(it.reasoning ?? '').slice(0, 200),
      })
    }
    console.log(' done')
  }
  console.log(`  Tokens: in=${totalIn} out=${totalOut} (~$${(totalIn * 0.000001 + totalOut * 0.000005).toFixed(4)})`)

  // 6. Bucket clusters.
  const approved  = []   // same_sku_parse_error + conf >= 0.92 + canonical_index valid
  const different = []
  const uncertain = []
  for (const c of ambigClusters) {
    const v = verdicts.get(c.cluster_id)
    if (!v) { uncertain.push({ c, why: 'no verdict' }); continue }
    if (v.verdict === 'different_skus') {
      different.push({ c, v })
    } else if (v.verdict === 'same_sku_parse_error' && Number.isFinite(v.conf) && v.conf >= CONF_FLOOR &&
               Number.isInteger(v.canonical_index) && v.canonical_index >= 0 && v.canonical_index < c.members.length) {
      const canonical = c.members[v.canonical_index]
      const others    = c.members.filter((_, i) => i !== v.canonical_index)
      approved.push({ c, v, canonical, others })
    } else {
      uncertain.push({ c, why: `${v.verdict} conf=${v.conf} ci=${v.canonical_index}` })
    }
  }
  console.log(`\n  Approved (SAME_SKU_PARSE_ERROR): ${approved.length}`)
  console.log(`  Different SKUs (kept separate):  ${different.length}`)
  console.log(`  Uncertain (owner review):        ${uncertain.length}`)

  // 7. Change counts on approved
  let totalAliasRepoints = 0, totalIngredientUpdates = 0, totalArchives = 0
  for (const a of approved) {
    let aliases = 0, ingredients = 0
    for (const o of a.others) {
      aliases     += (aliasesByProduct.get(o.id) ?? []).length
      ingredients += (recipeRefsByProduct.get(o.id) ?? []).length
    }
    a.changeCount = { aliases, ingredients }
    totalAliasRepoints     += aliases
    totalIngredientUpdates += ingredients
    totalArchives          += a.others.length
  }
  console.log(`  Will repoint ${totalAliasRepoints} aliases, update ${totalIngredientUpdates} recipe_ingredients, archive ${totalArchives} duplicate products`)

  // 8. Samples
  console.log(`\n  Approved sample (first 10):`)
  for (const a of approved.slice(0, 10)) {
    console.log(`    ✓ root="${a.c.root}"`)
    console.log(`        canonical: "${a.canonical.name}" (pack=${a.canonical.pack_size ?? '∅'} ${a.canonical.base_unit ?? '∅'})`)
    for (const o of a.others) console.log(`        archive:  "${o.name}" (pack=${o.pack_size ?? '∅'} ${o.base_unit ?? '∅'})  aliases=${(aliasesByProduct.get(o.id) ?? []).length}  recipe_refs=${(recipeRefsByProduct.get(o.id) ?? []).length}`)
    console.log(`        reasoning: ${a.v.rsn}  (conf ${a.v.conf.toFixed(2)})`)
  }
  console.log(`\n  Different-SKUs sample (first 8):`)
  for (const { c, v } of different.slice(0, 8)) {
    console.log(`    ≠ root="${c.root}"  ${c.members.length} members  reasoning: ${v.rsn}`)
    for (const m of c.members) console.log(`        - "${m.name}" (pack=${m.pack_size ?? '∅'} ${m.base_unit ?? '∅'})`)
  }
  if (uncertain.length > 0) {
    console.log(`\n  Uncertain sample (first 5):`)
    for (const { c, why } of uncertain.slice(0, 5)) {
      console.log(`    ? root="${c.root}"  ${why}`)
    }
  }

  // 9. APPLY
  if (APPLY && approved.length > 0) {
    console.log(`\n  APPLYING ${approved.length} cluster collapses…`)
    let ok = 0, err = 0
    for (const a of approved) {
      try {
        for (const o of a.others) {
          const aliasIds = aliasesByProduct.get(o.id) ?? []
          if (aliasIds.length > 0) {
            for (let i = 0; i < aliasIds.length; i += 100) {
              const slice = aliasIds.slice(i, i + 100)
              const { error } = await db.from('product_aliases').update({ product_id: a.canonical.id }).in('id', slice)
              if (error) throw new Error(`alias repoint: ${error.message}`)
            }
          }
          const ingIds = recipeRefsByProduct.get(o.id) ?? []
          if (ingIds.length > 0) {
            for (let i = 0; i < ingIds.length; i += 100) {
              const slice = ingIds.slice(i, i + 100)
              const { error } = await db.from('recipe_ingredients').update({ product_id: a.canonical.id }).in('id', slice)
              if (error) throw new Error(`recipe_ingredient update: ${error.message}`)
            }
          }
          const { error: aErr } = await db.from('products').update({ archived_at: new Date().toISOString() }).eq('id', o.id)
          if (aErr) throw new Error(`archive: ${aErr.message}`)
        }
        ok++
      } catch (e) {
        console.error(`    cluster "${a.c.root}" failed: ${e.message}`)
        err++
      }
    }
    console.log(`  Collapsed: ${ok} clusters  (errors: ${err})`)
  } else if (approved.length > 0) {
    console.log(`\n  (DRY mode — re-run with --apply to write)`)
  }
}

console.log('\ndone')

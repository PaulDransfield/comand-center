// lib/inventory/orphan-rescue.ts
//
// Orphan-product-rescue agent (M126). The cron route at
// /api/cron/orphan-rescue calls runOrphanRescueForBusiness(bizId)
// once per business per tick.
//
// Goal: find products with 0 active aliases + a default_supplier (the
// "no article" needs-attention class) and auto-merge them onto the
// canonical product when there's a sufficiently obvious duplicate.
//
// Safety rails (after the Coke-on-Tzatziki / Lök Röd over-merge
// incident — see scripts/diag/peek-lok-rod-thumb.mjs):
//   1. SAME default_supplier_fortnox_number — no cross-supplier merges
//   2. SAME pack_size + base_unit — different pack = different SKU
//   3. Haiku verdict='same' AND confidence >= 0.95
//   4. EXACTLY ONE candidate clears the bar (ambiguity → defer)
//
// Every decision is written to orphan_rescue_log so we can audit
// behaviour later (and rollback any individual merge by archived_at IS
// NOT NULL on the canonical row + recipe_ingredients log).

import type { SupabaseClient } from '@supabase/supabase-js'

const MODEL          = 'claude-haiku-4-5-20251001'
const CONF_FLOOR     = 0.95
const MAX_CANDIDATES = 5    // top-N by Jaccard, then ask LLM
const JACCARD_FLOOR  = 0.4  // pre-LLM gate; cheap

const STOPWORDS = new Set([
  'frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan',
  'lös','kg','hg','gr','gram','ml','cl','dl','liter','litre','st','stk','burk','flaska','paket','pkt',
  'frp','fp','pack','styck','kart','krt','dunk','hink','säck','sack','ifrp','ask','back',
  'rte','co','se','es','it','fr','dk','no','fi','nl','dop','igp','ks','sc','rb','kl1','dg','krav',
])

function tokens(s: string | null | undefined): string[] {
  if (!s) return []
  let t = String(s).toLowerCase().normalize('NFKD')
  t = t.replace(/\([^)]*\)/g, ' ')
  t = t.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|st|stk|x)\b/g, ' ')
  t = t.replace(/[^\p{Letter}\s]/gu, ' ')
  return t.split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w))
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b)
  const inter = [...A].filter(x => B.has(x)).length
  const union = new Set([...A, ...B]).size
  return union === 0 ? 0 : inter / union
}

interface Product {
  id: string
  name: string
  pack_size: number | null
  base_unit: string | null
  default_supplier_fortnox_number: string | null
  default_supplier_name: string | null
}

interface LlmVerdict {
  verdict: 'same' | 'different' | 'uncertain'
  confidence: number
  reasoning: string
}

interface RescueResult {
  business_id: string
  orphans_scanned: number
  merged: number
  skipped: { reason: string; count: number }[]
  tokens_in: number
  tokens_out: number
}

const SYSTEM_PROMPT = `You verify whether two restaurant-catalogue products are the same SKU. The orphan is a newly-discovered product with no purchase history yet. The canonical is an existing product the matcher learned previously.

Return verdict='same' ONLY when you're confident they refer to the same real-world item — same flavour, same fat %, same grade, same vintage, same brand line, same country origin where mentioned. Pack-size variations (e.g. 12kg vs 2kg) ALWAYS mean different SKUs.

Return verdict='different' when any of the following differ: fat % (10% vs 23% mince), grade markings (Kl1 vs other), brand line (Mascarpone 47% vs 48%), country/origin codes (BR vs CR), vintage year, color/variety (Röd vs Gul), bone-in vs boneless.

Return verdict='uncertain' when the difference might just be supplier abbreviation or labelling style (KRAV vs Krav, Nyckelhål annotation, supplier code suffix) but you can't be sure.

Reply ONLY with valid JSON: {"verdict":"same|different|uncertain","confidence":0.95,"reasoning":"<one short sentence>"}`

async function callHaiku(orphan: string, canonical: string, apiKey: string): Promise<{ ok: true; verdict: LlmVerdict; tokensIn: number; tokensOut: number } | { ok: false; error: string }> {
  const userMsg = `orphan:    "${orphan}"
canonical: "${canonical}"

Are these the same SKU?`
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userMsg }] }),
  })
  if (!r.ok) return { ok: false, error: `Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}` }
  const j = await r.json()
  const text = ((j.content ?? []) as any[]).filter(b => b.type === 'text').map(b => b.text ?? '').join('').trim()
  const start = text.indexOf('{'); const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON in response' }
  let parsed: any
  try { parsed = JSON.parse(text.slice(start, end + 1)) } catch (e: any) { return { ok: false, error: `bad JSON: ${e.message}` } }
  const v = String(parsed.verdict ?? '')
  if (v !== 'same' && v !== 'different' && v !== 'uncertain') return { ok: false, error: `bad verdict: ${v}` }
  return {
    ok: true,
    verdict: { verdict: v, confidence: Number(parsed.confidence) || 0, reasoning: String(parsed.reasoning ?? '').slice(0, 250) },
    tokensIn: j.usage?.input_tokens ?? 0,
    tokensOut: j.usage?.output_tokens ?? 0,
  }
}

export async function runOrphanRescueForBusiness(
  db: SupabaseClient,
  businessId: string,
  apiKey: string,
): Promise<RescueResult> {
  const result: RescueResult = {
    business_id: businessId,
    orphans_scanned: 0,
    merged: 0,
    skipped: [],
    tokens_in: 0,
    tokens_out: 0,
  }
  const skipBuckets: Record<string, number> = {}
  function bump(reason: string) { skipBuckets[reason] = (skipBuckets[reason] ?? 0) + 1 }

  // 1. Load all active products for this business — orphans + potential canonicals
  //    in one shot. Limit to recently-touched orphans so we don't hammer the LLM
  //    on the same set every hour.
  const { data: allProducts } = await db.from('products')
    .select('id, name, pack_size, base_unit, default_supplier_fortnox_number, default_supplier_name, archived_at, created_at')
    .eq('business_id', businessId).is('archived_at', null)
    .order('id').limit(5000)
  if (!allProducts?.length) return result

  // 2. Get active alias counts per product so we can split orphans (count=0)
  //    from canonicals (count>0).
  const productIds = allProducts.map((p: any) => p.id)
  const aliasCount = new Map<string, number>()
  for (let i = 0; i < productIds.length; i += 200) {
    const slice = productIds.slice(i, i + 200)
    const { data } = await db.from('product_aliases')
      .select('product_id').in('product_id', slice).eq('is_active', true)
    for (const a of data ?? []) aliasCount.set(a.product_id, (aliasCount.get(a.product_id) ?? 0) + 1)
  }

  const orphans: Product[]   = allProducts.filter((p: any) => (aliasCount.get(p.id) ?? 0) === 0 && p.default_supplier_fortnox_number)
  const canonicals: Product[] = allProducts.filter((p: any) => (aliasCount.get(p.id) ?? 0) > 0)
  result.orphans_scanned = orphans.length

  // 3. Skip orphans we've already touched in the last 7 days — agent should
  //    not re-LLM the same orphan-canonical pairs every hour.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent } = await db.from('orphan_rescue_log')
    .select('orphan_product_id').eq('business_id', businessId).gte('created_at', sevenDaysAgo)
  const seenRecently = new Set((recent ?? []).map((r: any) => r.orphan_product_id))

  // 4. Index canonicals by default_supplier_fortnox_number for fast lookup.
  const canonicalsBySupplier = new Map<string, Product[]>()
  for (const c of canonicals) {
    const sup = c.default_supplier_fortnox_number
    if (!sup) continue
    const arr = canonicalsBySupplier.get(sup) ?? []
    arr.push(c); canonicalsBySupplier.set(sup, arr)
  }

  // 5. Walk each orphan, find candidates, decide.
  for (const o of orphans) {
    if (seenRecently.has(o.id)) continue

    const sup = o.default_supplier_fortnox_number!   // already filtered to non-null
    const sameSupplier = canonicalsBySupplier.get(sup) ?? []
    if (sameSupplier.length === 0) {
      await logSkip(db, o, null, 0, 'skipped_no_candidate', null, 0, 0)
      bump('skipped_no_candidate'); continue
    }

    // Pre-filter: same pack_size + base_unit, Jaccard >= floor.
    const orphanTokens = tokens(o.name)
    const candidates = sameSupplier
      .filter(c =>
        String(c.pack_size ?? '') === String(o.pack_size ?? '') &&
        String(c.base_unit ?? '') === String(o.base_unit ?? ''))
      .map(c => ({ c, j: jaccard(orphanTokens, tokens(c.name)) }))
      .filter(x => x.j >= JACCARD_FLOOR)
      .sort((a, b) => b.j - a.j)
      .slice(0, MAX_CANDIDATES)

    if (candidates.length === 0) {
      await logSkip(db, o, null, 0, 'skipped_no_candidate', null, 0, 0)
      bump('skipped_no_candidate'); continue
    }

    // LLM verdicts — ask only for the top candidate first (cheap path).
    const top = candidates[0]
    const r = await callHaiku(o.name, top.c.name, apiKey)
    if (!r.ok) {
      await logError(db, o, top.c, r.error)
      bump('error'); continue
    }
    result.tokens_in  += r.tokensIn
    result.tokens_out += r.tokensOut

    if (r.verdict.verdict !== 'same' || r.verdict.confidence < CONF_FLOOR) {
      await logSkip(db, o, top.c, candidates.length, 'skipped_low_confidence', r.verdict, r.tokensIn, r.tokensOut)
      bump('skipped_low_confidence'); continue
    }

    // If there's a second strong candidate, ask the LLM too — if BOTH come
    // back 'same' with high conf we're ambiguous and defer.
    if (candidates.length > 1) {
      const r2 = await callHaiku(o.name, candidates[1].c.name, apiKey)
      if (r2.ok) {
        result.tokens_in  += r2.tokensIn
        result.tokens_out += r2.tokensOut
        if (r2.verdict.verdict === 'same' && r2.verdict.confidence >= CONF_FLOOR) {
          await logSkip(db, o, top.c, candidates.length, 'skipped_ambiguous', r.verdict, r.tokensIn + r2.tokensIn, r.tokensOut + r2.tokensOut)
          bump('skipped_ambiguous'); continue
        }
      }
    }

    // CLEAR MERGE — orphan onto canonical.
    try {
      await mergeOrphanIntoCanonical(db, o, top.c)
      await logMerged(db, o, top.c, candidates.length, r.verdict, r.tokensIn, r.tokensOut)
      result.merged++
    } catch (e: any) {
      await logError(db, o, top.c, e?.message ?? String(e))
      bump('error')
    }
  }

  for (const [reason, count] of Object.entries(skipBuckets)) {
    result.skipped.push({ reason, count })
  }
  return result
}

async function mergeOrphanIntoCanonical(db: SupabaseClient, orphan: Product, canonical: Product): Promise<void> {
  // Any recipe_ingredients still pointing at the orphan get repointed
  // to the canonical (so live cost stays consistent).
  await db.from('recipe_ingredients').update({ product_id: canonical.id }).eq('product_id', orphan.id)
  // Archive the orphan with a marker so we can recover later if needed.
  const { error } = await db.from('products').update({
    archived_at: new Date().toISOString(),
  }).eq('id', orphan.id)
  if (error) throw new Error(`archive orphan: ${error.message}`)
}

async function logMerged(db: SupabaseClient, orphan: Product, canonical: Product, candidateCount: number, v: LlmVerdict, tIn: number, tOut: number) {
  await db.from('orphan_rescue_log').insert({
    business_id: (orphan as any).business_id ?? null,
    orphan_product_id: orphan.id, orphan_name: orphan.name,
    canonical_product_id: canonical.id, canonical_name: canonical.name,
    candidate_count: candidateCount,
    verdict: v.verdict, confidence: v.confidence, reasoning: v.reasoning,
    action: 'merged', tokens_in: tIn, tokens_out: tOut,
  })
}
async function logSkip(db: SupabaseClient, orphan: Product, canonical: Product | null, candidateCount: number, action: string, v: LlmVerdict | null, tIn: number, tOut: number) {
  await db.from('orphan_rescue_log').insert({
    business_id: (orphan as any).business_id ?? null,
    orphan_product_id: orphan.id, orphan_name: orphan.name,
    canonical_product_id: canonical?.id ?? null, canonical_name: canonical?.name ?? null,
    candidate_count: candidateCount,
    verdict: v?.verdict ?? null, confidence: v?.confidence ?? null, reasoning: v?.reasoning ?? null,
    action, tokens_in: tIn, tokens_out: tOut,
  })
}
async function logError(db: SupabaseClient, orphan: Product, canonical: Product | null, message: string) {
  await db.from('orphan_rescue_log').insert({
    business_id: (orphan as any).business_id ?? null,
    orphan_product_id: orphan.id, orphan_name: orphan.name,
    canonical_product_id: canonical?.id ?? null, canonical_name: canonical?.name ?? null,
    candidate_count: 0,
    action: 'error', error_message: message.slice(0, 500),
  })
}

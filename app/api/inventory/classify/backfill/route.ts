// app/api/inventory/classify/backfill/route.ts
//
// POST — run the classification cascade against every product at a
// business that doesn't yet have a sub_category set (or whose
// confidence is below a threshold). Cascade order:
//
//   1. supplier_articles.category_path (highest signal: supplier said so)
//   2. cross_customer (another business has the same supplier+article
//                      already classified — copy the answer)
//   3. openfoodfacts (GTIN lookup — Push 2)
//   4. web_llm (Brave/Tavily search + Sonnet — Push 2)
//   5. name_llm (Haiku from product name alone — last resort)
//
// owner-source rows are NEVER overwritten regardless of incoming
// signal — manual override always wins.
//
// Body: { business_id: string, dry_run?: bool, only_sources?: string[] }
// Returns per-product result rows so the owner can see what happened.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { AI_MODELS } from '@/lib/ai/models'
import { SCOPE_NOTE } from '@/lib/ai/scope'
import { SUB_CATEGORIES, type SubCategory } from '@/lib/inventory/taxonomy'
import { mapCategoryPath, mapStorageType } from '@/lib/inventory/category-mapper'
import { brandToSubCategory, isNavigationMenuPath } from '@/lib/inventory/brand-mapper'
import { lookupGtin, mapOffCategories, mapOffAllergens } from '@/lib/inventory/openfoodfacts'
import { searchTavily, buildClassificationQuery } from '@/lib/web/tavily'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

interface ProductRow {
  id:                   string
  name:                 string
  category:             string | null
  sub_category:         string | null
  storage_type:         string | null
  brand:                string | null
  gtin:                 string | null
  classification_source:     string | null
  classification_confidence: number | null
  archived_at:          string | null
}

interface ClassifyResult {
  product_id:   string
  product_name: string
  before:       { sub_category: string | null; source: string | null; confidence: number | null }
  after:        { sub_category: string | null; storage_type: string | null; source: string; confidence: number } | null
  reason:       string         // explanation for owner audit
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = body.business_id ? String(body.business_id).trim() : null
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const dryRun = !!body.dry_run
  const onlySources: Set<string> = new Set(Array.isArray(body.only_sources) ? body.only_sources : [])
  // Tavily web-search is opt-in — it's the slowest source (8x concurrent
  // 10s timeouts) and at 800 long-tail items blows past Vercel's 300s
  // function cap. Cascade defaults to: supplier_articles -> cross_customer
  // -> OpenFoodFacts -> name_llm. Owner re-clicks with include_tavily=true
  // for the final long-tail pass.
  const includeTavily = !!body.include_tavily
  // Hard cap on candidates per request so even a fresh 1000-item catalogue
  // completes in one shot. User re-clicks to process the next batch.
  const MAX_CANDIDATES = 250

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // ── Load all candidate products (not owner-set, not archived) ──────
  // Confidence threshold: re-classify anything below 0.7 (LLM-from-name
  // is 0.5, web_llm is 0.7). Owner rows have source='owner' → never touched.
  const products: ProductRow[] = []
  for (let from = 0; ; from += 1000) {
    // Owner-source filter is applied JS-side below. Doing it at the DB
    // layer hits two PostgREST gotchas:
    //   - `.neq('classification_source', 'owner')` excludes NULL rows
    //     (three-valued logic), so a fresh catalogue returns 0 candidates.
    //   - `.or('classification_source.is.null,classification_source.neq.owner')`
    //     trips a PostgREST 400 on some syntaxes.
    // Loading all rows and JS-filtering is simpler and safe.
    const { data, error } = await db
      .from('products')
      .select('id, name, category, sub_category, storage_type, brand, gtin, classification_source, classification_confidence, archived_at')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    products.push(...((data ?? []) as ProductRow[]))
    if (!data || data.length < 1000) break
    if (products.length > 20_000) break
  }

  // Filter to those needing classification (null OR low confidence) AND
  // never overwrite owner-source rows (manual overrides win permanently).
  // JS-side handles NULL correctly without PostgREST three-valued-logic
  // surprises. Hard cap at MAX_CANDIDATES so the request completes
  // before Vercel's 300s function cap.
  const allCandidates = products.filter(p =>
    p.classification_source !== 'owner' &&
    (p.sub_category == null || (p.classification_confidence ?? 0) < 0.7),
  )
  const totalUnprocessed = allCandidates.length
  const candidates = allCandidates.slice(0, MAX_CANDIDATES)
  console.log(`[classify] biz=${businessId} loaded=${products.length} candidates=${candidates.length}/${allCandidates.length}`)

  if (candidates.length === 0) {
    return NextResponse.json({
      business_id:       businessId,
      total_candidates:  0,
      processed:         0,
      updated:           0,
      results:           [],
      message:           'Nothing to classify — every product already has a high-confidence sub_category.',
    })
  }

  // ── Source 1: supplier_articles direct lookup ───────────────────────
  // Pull aliases for these products + join to supplier_articles for the
  // category_path + storage_type signal.
  //
  // CRITICAL — supabase-js .in() with >~300 UUIDs blows the 16KB URL
  // header cap (UND_ERR_HEADERS_OVERFLOW) and surfaces as a Bad Request
  // 500. Chicce has ~800 candidates; we MUST batch. Canonical 100 per
  // batch from the no-silent-null memory.
  const productIds = candidates.map(p => p.id)
  const aliases: any[] = []
  const ALIAS_BATCH = 100
  for (let i = 0; i < productIds.length; i += ALIAS_BATCH) {
    const slice = productIds.slice(i, i + ALIAS_BATCH)
    const { data, error: aErr } = await db
      .from('product_aliases')
      .select('product_id, supplier_fortnox_number, article_number, last_seen_at')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .in('product_id', slice)
      .not('article_number', 'is', null)
    if (aErr) {
      console.error('[classify] aliases batch failed:', aErr)
      return NextResponse.json({ error: `aliases lookup failed: ${aErr.message}`, batch_start: i, batch_size: slice.length }, { status: 500 })
    }
    if (data) aliases.push(...data)
  }
  console.log(`[classify] aliases loaded: ${aliases.length}`)

  // Pick the most-recent alias per product (best supplier signal).
  const aliasByProduct = new Map<string, { supplier: string; article: string; last_seen: string | null }>()
  for (const a of aliases ?? []) {
    const prev = aliasByProduct.get(a.product_id)
    if (!prev || (a.last_seen_at && (!prev.last_seen || a.last_seen_at > prev.last_seen))) {
      aliasByProduct.set(a.product_id, {
        supplier:  String(a.supplier_fortnox_number),
        article:   String(a.article_number),
        last_seen: a.last_seen_at ?? null,
      })
    }
  }

  // Batch-fetch supplier_articles for every (supplier, article) we need.
  // PRIOR BUG: built a PostgREST OR clause with raw article_numbers
  // concatenated. Article numbers can contain `.`, `,`, `(`, `)` etc.
  // (e.g. "BX-08.05"). Those characters are PostgREST reserved syntax,
  // so the OR query was rejected with 400 "Bad Request" the moment any
  // such article was in the batch.
  //
  // Fix: group by supplier, then use `.in('article_number', [...])`
  // per supplier. PostgREST escapes `.in()` values properly; no manual
  // string assembly. JS-side filter rebuilds the exact (sup, art) pairs.
  const keysNeeded = Array.from(new Set(Array.from(aliasByProduct.values()).map(v => `${v.supplier}|${v.article}`)))
  const supplierArticleByKey = new Map<string, any>()
  if (keysNeeded.length > 0) {
    const articlesBySupplier = new Map<string, Set<string>>()
    for (const k of keysNeeded) {
      const [sup, art] = k.split('|')
      if (!articlesBySupplier.has(sup)) articlesBySupplier.set(sup, new Set())
      articlesBySupplier.get(sup)!.add(art)
    }
    for (const [sup, articleSet] of articlesBySupplier) {
      const articles = Array.from(articleSet)
      const BATCH = 300
      for (let i = 0; i < articles.length; i += BATCH) {
        const slice = articles.slice(i, i + BATCH)
        const { data: sa } = await db
          .from('supplier_articles')
          .select('supplier_fortnox_number, article_number, category_path, storage_type, brand, gtin, official_name')
          .eq('supplier_fortnox_number', sup)
          .in('article_number', slice)
        for (const row of sa ?? []) {
          supplierArticleByKey.set(`${row.supplier_fortnox_number}|${row.article_number}`, row)
        }
      }
    }
  }
  console.log(`[classify] supplier_articles hits: ${supplierArticleByKey.size}/${keysNeeded.length} (keys needed)`)
  if (keysNeeded.length > 0 && supplierArticleByKey.size === 0) {
    const sample = keysNeeded.slice(0, 5)
    console.log(`[classify] sample keys queried (none matched): ${JSON.stringify(sample)}`)
  }
  // Capture the first 15 unmapped category_paths so the owner can paste
  // them back. The mapper's Swedish regex rules need to match what MS
  // actually puts in this field; without seeing real samples we're
  // guessing.
  const unmappedPathsSample: Array<{ category_path: string | null; brand: string | null; storage: string | null }> = []
  for (const [key, sa] of supplierArticleByKey) {
    if (unmappedPathsSample.length >= 15) break
    const mapped = mapCategoryPath(sa.category_path, sa.storage_type)
    if (!mapped) {
      unmappedPathsSample.push({
        category_path: sa.category_path ?? null,
        brand:         sa.brand ?? null,
        storage:       sa.storage_type ?? null,
      })
    }
  }
  console.log(`[classify] unmapped category_paths sample: ${JSON.stringify(unmappedPathsSample)}`)

  // ── Source 2: cross-customer — same supplier+article seen at ANOTHER
  // business with sub_category already set. Highest-signal cross-tenant
  // hint after supplier_articles itself.
  //
  // Implementation: for the keys WITHOUT a supplier_articles row, look
  // up any product anywhere in the system with a matching alias AND a
  // non-null sub_category.
  const keysNotInSa = keysNeeded.filter(k => !supplierArticleByKey.has(k))
  const crossCustomerByKey = new Map<string, { sub_category: string | null; storage_type: string | null; brand: string | null }>()
  if (keysNotInSa.length > 0) {
    // Same fix as supplier_articles above — group by supplier, use .in()
    // on article_number, then JS-side filter back to the exact (sup, art)
    // pairs we asked for. Avoids the OR-syntax 400 on special chars.
    const articlesBySupplier = new Map<string, Set<string>>()
    for (const k of keysNotInSa) {
      const [sup, art] = k.split('|')
      if (!articlesBySupplier.has(sup)) articlesBySupplier.set(sup, new Set())
      articlesBySupplier.get(sup)!.add(art)
    }
    for (const [sup, articleSet] of articlesBySupplier) {
      const articles = Array.from(articleSet)
      const BATCH = 300
      for (let i = 0; i < articles.length; i += BATCH) {
        const slice = articles.slice(i, i + BATCH)
        const { data: matchingAliases } = await db
          .from('product_aliases')
          .select('product_id, supplier_fortnox_number, article_number')
          .eq('supplier_fortnox_number', sup)
          .in('article_number', slice)
          .eq('is_active', true)
        if (!matchingAliases || matchingAliases.length === 0) continue

        const otherProductIds = Array.from(new Set(matchingAliases.map(a => a.product_id)))
        const { data: otherProducts } = await db
          .from('products')
          .select('id, sub_category, storage_type, brand, classification_confidence')
          .in('id', otherProductIds)
          .not('sub_category', 'is', null)
          .gte('classification_confidence', 0.7)
        if (!otherProducts) continue

        const productSubBy = new Map<string, any>()
        for (const p of otherProducts) productSubBy.set(p.id, p)
        for (const a of matchingAliases) {
          const p = productSubBy.get(a.product_id)
          if (!p) continue
          const key = `${a.supplier_fortnox_number}|${a.article_number}`
          if (!crossCustomerByKey.has(key)) {
            crossCustomerByKey.set(key, {
              sub_category: p.sub_category,
              storage_type: p.storage_type,
              brand:        p.brand,
            })
          }
        }
      }
    }
  }

  // ── Pass 1: deterministic sources (supplier_articles + cross_customer) ─
  const results: ClassifyResult[] = []
  const remainingForLlm: ProductRow[] = []

  for (const p of candidates) {
    if (onlySources.size > 0 && !onlySources.has('supplier_articles') && !onlySources.has('cross_customer')) {
      remainingForLlm.push(p); continue
    }
    const alias = aliasByProduct.get(p.id)
    if (!alias) { remainingForLlm.push(p); continue }
    const key = `${alias.supplier}|${alias.article}`

    const sa = supplierArticleByKey.get(key)
    if (sa) {
      // Storage is always usable (kyl/fryst/Torrt are reliable).
      const storage = mapStorageType(sa.storage_type) ?? null

      // 1A. Try category_path — but ONLY if it isn't the bogus MS
      // sidebar nav string. The scraper bug grabbed the sister-supplier
      // menu rail; every product has the same useless 6-segment path.
      // Skip it cleanly when detected.
      const pathUsable = !isNavigationMenuPath(sa.category_path)
      if (pathUsable) {
        const mapped = mapCategoryPath(sa.category_path, sa.storage_type)
        if (mapped) {
          results.push({
            product_id: p.id,
            product_name: p.name,
            before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
            after: {
              sub_category: mapped.sub,
              storage_type: storage ?? mapped.storage ?? null,
              source:       'supplier_articles',
              confidence:   0.95,
            },
            reason: `Mapped from MS category_path "${sa.category_path}"`,
          })
          continue
        }
      }

      // 1B. Brand-based — covers the case where the path is bogus but
      // the brand field is meaningful ("San Pellegrino" → bev_water).
      const fromBrand = brandToSubCategory(sa.brand)
      if (fromBrand) {
        results.push({
          product_id: p.id,
          product_name: p.name,
          before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
          after: {
            sub_category: fromBrand,
            storage_type: storage,
            source:       'supplier_articles',
            confidence:   0.90,
          },
          reason: `Brand "${sa.brand}" maps to ${fromBrand}`,
        })
        continue
      }

      // 1C. Still no match — fall through to LLM, but with supplier
      // metadata (brand + storage) attached as enrichment so the LLM
      // gets richer context than name alone.
      remainingForLlm.push(p)
      continue
    }

    const cross = crossCustomerByKey.get(key)
    if (cross && cross.sub_category) {
      results.push({
        product_id: p.id,
        product_name: p.name,
        before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
        after: {
          sub_category: cross.sub_category as SubCategory,
          storage_type: cross.storage_type as any,
          source:       'cross_customer',
          confidence:   0.90,
        },
        reason: `Cross-customer match: same (supplier ${alias.supplier}, article ${alias.article}) classified at another business`,
      })
      continue
    }

    remainingForLlm.push(p)
  }

  // ── Source 3: OpenFoodFacts GTIN lookup ─────────────────────────────
  // For products whose supplier_articles row has a GTIN, hit the free
  // OFF API. ~60-80% hit rate on branded packaged goods. Allergens come
  // along for free.
  const stillUnclassified: ProductRow[] = []
  if (onlySources.size === 0 || onlySources.has('openfoodfacts')) {
    // Build (product → gtin) map from the supplier_articles cache loaded
    // earlier in the function.
    const gtinByProduct = new Map<string, string>()
    for (const p of remainingForLlm) {
      const alias = aliasByProduct.get(p.id)
      if (!alias) continue
      const sa = supplierArticleByKey.get(`${alias.supplier}|${alias.article}`)
      if (sa?.gtin && /^[0-9]{8,14}$/.test(String(sa.gtin))) {
        gtinByProduct.set(p.id, String(sa.gtin))
      }
    }

    // Lookup in parallel chunks of 10 to respect OFF's rate limits.
    const productsWithGtin = remainingForLlm.filter(p => gtinByProduct.has(p.id))
    const offResults = new Map<string, any>()
    const CONCURRENCY = 10
    for (let i = 0; i < productsWithGtin.length; i += CONCURRENCY) {
      const chunk = productsWithGtin.slice(i, i + CONCURRENCY)
      await Promise.all(chunk.map(async p => {
        const off = await lookupGtin(gtinByProduct.get(p.id))
        if (off.found) offResults.set(p.id, off)
      }))
    }

    for (const p of remainingForLlm) {
      const off = offResults.get(p.id)
      if (off && off.found) {
        const mappedSub = mapOffCategories(off.categories)
        if (mappedSub) {
          results.push({
            product_id:   p.id,
            product_name: p.name,
            before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
            after: {
              sub_category: mappedSub,
              storage_type: null,                       // OFF doesn't carry storage_type
              source:       'openfoodfacts',
              confidence:   0.85,
            },
            reason: `OpenFoodFacts hit (GTIN ${gtinByProduct.get(p.id)}): brand=${off.brand ?? '-'}, categories=${off.categories.slice(0, 3).join(',')}`,
          })
          continue
        }
      }
      stillUnclassified.push(p)
    }
  } else {
    stillUnclassified.push(...remainingForLlm)
  }

  // ── Source 4: Tavily web search + LLM (Sonnet for richer context) ───
  // Soft-fails to name_llm when TAVILY_API_KEY missing or API errors.
  const afterTavily: ProductRow[] = []
  if (stillUnclassified.length > 0 && includeTavily && process.env.TAVILY_API_KEY && (onlySources.size === 0 || onlySources.has('web_llm'))) {
    // Quota check before kicking off potentially many LLM calls.
    const usage = await checkAndIncrementAiLimit(db, auth.orgId)
    if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

    // Tavily searches in parallel chunks of 8 — cheaper tier limit is 5/sec.
    const TAVILY_CONC = 8
    const tavilyByProduct = new Map<string, { answer: string; brand: string | null }>()
    for (let i = 0; i < stillUnclassified.length; i += TAVILY_CONC) {
      const chunk = stillUnclassified.slice(i, i + TAVILY_CONC)
      await Promise.all(chunk.map(async p => {
        const q = buildClassificationQuery(p.name, null)
        const tv = await searchTavily(q, { search_depth: 'basic', max_results: 3, include_answer: true })
        if (tv && (tv.answer || tv.results.length > 0)) {
          const ctx = tv.answer || tv.results.slice(0, 3).map(r => `${r.title}: ${r.content}`).join('\n')
          tavilyByProduct.set(p.id, { answer: ctx.slice(0, 600), brand: null })
        }
      }))
    }

    // Batch LLM classification with Tavily context appended per product.
    // Sonnet for the better reasoning over fuzzy snippets — cost still
    // bounded because we only reach this path for the long tail.
    const SUB_KEYS = Object.keys(SUB_CATEGORIES).join(', ')
    const WEB_SYSTEM_PROMPT = `You classify Swedish restaurant products into a fixed taxonomy using web-search context.

${SCOPE_NOTE}

For each product you'll see its raw name and a short web-search summary. Pick the best-fit sub_category key. If the summary is irrelevant or contradicts the name, treat the summary as low-quality and rely on the name.

Available sub_category keys (use these EXACT strings):
${SUB_KEYS}

Storage type: "frozen" | "refrigerated" | "ambient" | null.

Output JSON ONLY:
[{ "id": "<product_id>", "sub_category": "<key or null>", "storage_type": "<value or null>", "brand": "<brand or null>", "confidence": 0.0-1.0 }]

Confidence 0.7+ when the web context clearly identifies the product. 0.5-0.6 when relying mostly on the name with thin web support.`

    const BATCH = 10
    const withContext = stillUnclassified.filter(p => tavilyByProduct.has(p.id))
    for (let i = 0; i < withContext.length; i += BATCH) {
      const slice = withContext.slice(i, i + BATCH)
      const userMsg = JSON.stringify(slice.map(p => ({
        id:      p.id,
        name:    p.name,
        web_context: tavilyByProduct.get(p.id)?.answer ?? '',
      })))

      const aiRes = await anthropicFetch({
        body: {
          model:       AI_MODELS.ANALYSIS,             // Sonnet — better at noisy context
          max_tokens:  1500,
          system:      [
            { type: 'text', text: WEB_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ],
          messages:    [{ role: 'user', content: userMsg }],
        },
      })

      if (!aiRes.ok) {
        afterTavily.push(...slice)
        continue
      }
      await logAiRequest(db, {
        org_id:        auth.orgId,
        request_type:  'classify_backfill_web',
        model:         AI_MODELS.ANALYSIS,
        input_tokens:  aiRes.tokensIn ?? 0,
        output_tokens: aiRes.tokensOut ?? 0,
      })

      const text = (aiRes.json as any)?.content?.[0]?.text?.trim() ?? '[]'
      let parsed: any[] = []
      try { parsed = JSON.parse(text.replace(/^```json\n?|\n?```$/g, '')) } catch { parsed = [] }
      const byId = new Map<string, any>()
      for (const r of parsed) if (r && r.id) byId.set(String(r.id), r)

      for (const p of slice) {
        const r = byId.get(p.id)
        if (!r || !r.sub_category || !(r.sub_category in SUB_CATEGORIES)) {
          afterTavily.push(p)
          continue
        }
        const conf = Math.max(0.3, Math.min(1.0, Number(r.confidence ?? 0.7)))
        results.push({
          product_id:   p.id,
          product_name: p.name,
          before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
          after: {
            sub_category: r.sub_category,
            storage_type: (r.storage_type === 'frozen' || r.storage_type === 'refrigerated' || r.storage_type === 'ambient') ? r.storage_type : null,
            source:       'web_llm',
            confidence:   Math.min(0.75, conf),
          },
          reason: 'Tavily web search + Sonnet',
        })
      }
    }

    // Products that had NO Tavily context at all (or Tavily returned
    // nothing useful) fall through to name_llm.
    afterTavily.push(...stillUnclassified.filter(p => !tavilyByProduct.has(p.id)))
  } else {
    afterTavily.push(...stillUnclassified)
  }

  // Replace remainingForLlm with the post-Tavily set so the LLM-from-name
  // pass below operates on the genuinely last-resort remainder.
  remainingForLlm.length = 0
  remainingForLlm.push(...afterTavily)

  // ── Source 5: LLM-from-name fallback ────────────────────────────────
  // For products we couldn't deterministically classify. Batch in groups
  // of 25 to keep prompt small + cacheable. Haiku 4.5.
  if (remainingForLlm.length > 0 && (onlySources.size === 0 || onlySources.has('name_llm'))) {
    const usage = await checkAndIncrementAiLimit(db, auth.orgId)
    if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

    const SUB_KEYS = Object.keys(SUB_CATEGORIES).join(', ')
    const SYSTEM_PROMPT = `You classify Swedish restaurant products into a fixed taxonomy.

${SCOPE_NOTE}

You will receive a JSON array of products. For EACH product, return the best-fit sub_category key from the list. If you genuinely cannot tell, return null.

Products MAY include supplier-provided context fields:
  - "brand"          — known brand name (e.g. "San Pellegrino", "Fanta")
  - "storage"        — supplier storage type: "kyl" (refrigerated), "fryst" (frozen), "Torrt" / "rum" (ambient/dry), "Non food" (non-food disposable)
  - "official_name"  — supplier's canonical product name (usually clearer than the invoice line)
USE these signals heavily. A "brand: Fanta" with "storage: Torrt" is unambiguously bev_soft_drinks.

Available sub_category keys (use these EXACT strings):
${SUB_KEYS}

Storage type values for OUTPUT: "frozen" | "refrigerated" | "ambient" | null.
Map supplier hints: "fryst"/"djupfryst" → "frozen"; "kyl"/"kyld"/"kylvara" → "refrigerated"; "Torrt"/"rum"/"rumstemp"/"kolonial"/"Non food" → "ambient".

Output JSON ONLY:
[{ "id": "<product_id>", "sub_category": "<key or null>", "storage_type": "<value or null>", "brand": "<brand name or null>", "confidence": 0.0-1.0 }]

Tips:
- Swedish words: "mjölk" = milk, "ost" = cheese, "kött" = meat, "kyckling" = chicken, "fisk" = fish, "vin" = wine, "öl" = beer
- "HGN" / "JNK" / "MEG" etc. suffixes are MS brand codes, ignore for classification
- Wine without colour info → default alc_wine_red (most common in Swedish restaurants)
- Confidence: 0.8+ when brand + name unambiguous; 0.65 when name alone is clear; 0.5 when guessing.`

    const BATCH = 25
    for (let i = 0; i < remainingForLlm.length; i += BATCH) {
      const slice = remainingForLlm.slice(i, i + BATCH)
      // Augment each row with supplier metadata when we have it.
      // brand + storage from supplier_articles meaningfully sharpen the
      // LLM's call vs the bare product name.
      const userMsg = JSON.stringify(slice.map(p => {
        const alias = aliasByProduct.get(p.id)
        const sa = alias ? supplierArticleByKey.get(`${alias.supplier}|${alias.article}`) : null
        return {
          id:       p.id,
          name:     p.name,
          category: p.category,
          brand:    sa?.brand           ?? null,
          storage:  sa?.storage_type    ?? null,
          official_name: sa?.official_name ?? null,
        }
      }))

      const aiRes = await anthropicFetch({
        body: {
          model:       AI_MODELS.AGENT,
          max_tokens:  2000,
          system:      [
            { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          ],
          messages:    [{ role: 'user', content: userMsg }],
        },
      })
      if (!aiRes.ok) {
        // Soft-fail — mark as unclassified, keep going
        for (const p of slice) {
          results.push({
            product_id: p.id, product_name: p.name,
            before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
            after: null,
            reason: `LLM error: ${aiRes.errorText ?? aiRes.status}`,
          })
        }
        continue
      }
      await logAiRequest(db, {
        org_id:        auth.orgId,
        request_type:  'classify_backfill',
        model:         AI_MODELS.AGENT,
        input_tokens:  aiRes.tokensIn ?? 0,
        output_tokens: aiRes.tokensOut ?? 0,
      })

      const text = (aiRes.json as any)?.content?.[0]?.text?.trim() ?? '[]'
      let parsed: any[] = []
      try { parsed = JSON.parse(text.replace(/^```json\n?|\n?```$/g, '')) } catch { parsed = [] }
      const byId = new Map<string, any>()
      for (const r of parsed) if (r && r.id) byId.set(String(r.id), r)

      for (const p of slice) {
        const r = byId.get(p.id)
        if (!r || !r.sub_category || !(r.sub_category in SUB_CATEGORIES)) {
          results.push({
            product_id: p.id, product_name: p.name,
            before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
            after: null,
            reason: 'LLM could not classify from name',
          })
          continue
        }
        const conf = Math.max(0.1, Math.min(1.0, Number(r.confidence ?? 0.5)))
        results.push({
          product_id: p.id, product_name: p.name,
          before: { sub_category: p.sub_category, source: p.classification_source, confidence: p.classification_confidence },
          after: {
            sub_category: r.sub_category,
            storage_type: (r.storage_type === 'frozen' || r.storage_type === 'refrigerated' || r.storage_type === 'ambient') ? r.storage_type : null,
            source:       'name_llm',
            confidence:   Math.min(0.55, conf),  // cap at 0.55 — LLM-from-name is best treated as low-confidence
          },
          reason: `LLM from name (Haiku)`,
        })
      }
    }
  }

  // ── Apply writes ────────────────────────────────────────────────────
  // The owner-skip safeguard is enforced at the candidate-filter step
  // (results never contain owner-source rows), so the UPDATE doesn't
  // need a DB-level guard. Keeping the UPDATE filter-free avoids the
  // PostgREST OR-syntax gotcha.
  let updated = 0
  const writableResults = results.filter(r => r.after && r.before.source !== 'owner')
  console.log(`[classify] writable results: ${writableResults.length}/${results.length} (rest had after=null or owner-source)`)
  let updateErrors = 0
  let firstUpdateError: string | null = null
  if (!dryRun) {
    for (const r of writableResults) {
      const { error: uErr } = await db
        .from('products')
        .update({
          sub_category:              r.after!.sub_category,
          storage_type:              r.after!.storage_type,
          classification_source:     r.after!.source,
          classification_confidence: r.after!.confidence,
          classification_last_at:    new Date().toISOString(),
        })
        .eq('id', r.product_id)
      if (uErr) {
        updateErrors++
        if (!firstUpdateError) firstUpdateError = uErr.message
        console.error(`[classify] update failed for product ${r.product_id}: ${uErr.message}`)
      } else {
        updated++
      }
    }
    if (updateErrors > 0) {
      console.error(`[classify] ${updateErrors} updates failed. first error: ${firstUpdateError}`)
    }
  }

  return NextResponse.json({
    business_id:           businessId,
    total_unprocessed:     totalUnprocessed,                       // full backlog before cap
    processed_this_run:    candidates.length,
    remaining_after_run:   Math.max(0, totalUnprocessed - candidates.length),
    updated:               dryRun ? 0 : updated,
    update_errors:         updateErrors,
    first_update_error:    firstUpdateError,
    dry_run:               dryRun,
    include_tavily:        includeTavily,
    debug: {
      candidates_count:     candidates.length,
      aliases_count:        aliases.length,
      supplier_keys_needed: keysNeeded.length,
      supplier_articles_hits: supplierArticleByKey.size,
      writable_results:     writableResults.length,
      unmapped_paths_sample: unmappedPathsSample,
    },
    by_source: {
      supplier_articles: results.filter(r => r.after?.source === 'supplier_articles').length,
      cross_customer:    results.filter(r => r.after?.source === 'cross_customer').length,
      openfoodfacts:     results.filter(r => r.after?.source === 'openfoodfacts').length,
      web_llm:           results.filter(r => r.after?.source === 'web_llm').length,
      name_llm:          results.filter(r => r.after?.source === 'name_llm').length,
      unclassified:      results.filter(r => !r.after).length,
    },
    results,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

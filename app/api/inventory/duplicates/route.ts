// app/api/inventory/duplicates/route.ts
//
// GET — find clusters of products that the supplier itself has already
// confirmed are the same SKU. Method: group product_aliases by
// (supplier_fortnox_number, article_number); any group whose aliases
// point at ≥2 distinct products is a duplicate cluster.
//
// Article number is the strongest possible duplicate signal we have —
// it's the SUPPLIER'S own primary key for the SKU. If Martin Servera
// ships you article 105529 twice under slightly different descriptions
// and the matcher created two products for them, those products are
// objectively the same thing.
//
// This is more reliable than name normalisation or trigram similarity
// because the supplier signed the answer themselves. Trigram catches
// cases where the supplier ships the same SKU under a renamed product
// row (rare). Article-code catches the common case where supplier-side
// description noise (whitespace, brand-code suffixes, encoding quirks)
// produced sibling products in our catalogue.
//
// Returns clusters with each member product's: id, name, alias count,
// recipe-use count, and most-recent invoice date — enough to pick the
// canonical without leaving the page.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ClusterMember {
  product_id:        string
  product_name:      string
  product_category:  string | null
  archived_at:       string | null
  active_alias_count: number
  recipe_use_count:   number
  latest_invoice_date: string | null
}

interface DuplicateCluster {
  supplier_fortnox_number: string
  supplier_name:           string | null
  article_number:          string
  member_count:            number
  members:                 ClusterMember[]
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // ── Pull every active alias with an article number, then group ─────
  // Filtering out NULL article_number client-side because PostgREST
  // .not('article_number', 'is', null) chained with .eq on biz works,
  // but we still need the rest of the row (supplier_name, product_id)
  // to build the cluster, so a single SELECT is simplest.
  const aliases: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('product_aliases')
      .select('id, product_id, supplier_fortnox_number, supplier_name_snapshot, article_number, last_seen_at')
      .eq('business_id', businessId)
      .eq('is_active', true)
      .not('article_number', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    aliases.push(...(data ?? []))
    if (!data || data.length < 1000) break
    if (aliases.length > 50_000) break // safety
  }

  // Group by (supplier_fortnox_number, article_number)
  const byKey = new Map<string, { supplier_name: string | null; product_ids: Set<string>; latest_seen_by_pid: Map<string, string | null> }>()
  for (const a of aliases) {
    const sup = String(a.supplier_fortnox_number ?? '').trim()
    const art = String(a.article_number ?? '').trim()
    if (!sup || !art) continue
    const key = `${sup}|${art}`
    if (!byKey.has(key)) {
      byKey.set(key, { supplier_name: a.supplier_name_snapshot ?? null, product_ids: new Set(), latest_seen_by_pid: new Map() })
    }
    const slot = byKey.get(key)!
    slot.product_ids.add(a.product_id)
    const prev = slot.latest_seen_by_pid.get(a.product_id) ?? null
    if (!prev || (a.last_seen_at && a.last_seen_at > prev)) {
      slot.latest_seen_by_pid.set(a.product_id, a.last_seen_at ?? null)
    }
  }

  // Keep only the actual duplicate keys (≥2 distinct products)
  const dupKeys: Array<{ key: string; supplier_name: string | null; product_ids: string[]; latest_seen_by_pid: Map<string, string | null> }> = []
  for (const [key, slot] of byKey) {
    if (slot.product_ids.size >= 2) {
      dupKeys.push({
        key,
        supplier_name: slot.supplier_name,
        product_ids:   Array.from(slot.product_ids),
        latest_seen_by_pid: slot.latest_seen_by_pid,
      })
    }
  }

  if (dupKeys.length === 0) {
    return NextResponse.json(
      { business_id: businessId, clusters: [], total_clusters: 0, total_affected_products: 0 },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // Hydrate per-product metadata so the UI can show name + counts
  const allPids = Array.from(new Set(dupKeys.flatMap(d => d.product_ids)))
  const [productsRes, aliasCountsRes, recipeCountsRes] = await Promise.all([
    db.from('products')
      .select('id, name, category, archived_at')
      .in('id', allPids),
    db.from('product_aliases')
      .select('product_id', { count: 'exact', head: false })
      .eq('business_id', businessId)
      .eq('is_active', true)
      .in('product_id', allPids),
    db.from('recipe_ingredients')
      .select('product_id', { count: 'exact', head: false })
      .in('product_id', allPids),
  ])
  if (productsRes.error)     return NextResponse.json({ error: productsRes.error.message }, { status: 500 })
  if (aliasCountsRes.error)  return NextResponse.json({ error: aliasCountsRes.error.message }, { status: 500 })
  if (recipeCountsRes.error) return NextResponse.json({ error: recipeCountsRes.error.message }, { status: 500 })

  const productById = new Map<string, any>()
  for (const p of productsRes.data ?? []) productById.set(p.id, p)

  const aliasCountByPid = new Map<string, number>()
  for (const row of aliasCountsRes.data ?? []) {
    aliasCountByPid.set(row.product_id, (aliasCountByPid.get(row.product_id) ?? 0) + 1)
  }

  const recipeCountByPid = new Map<string, number>()
  for (const row of recipeCountsRes.data ?? []) {
    recipeCountByPid.set(row.product_id, (recipeCountByPid.get(row.product_id) ?? 0) + 1)
  }

  // ── Build cluster output ────────────────────────────────────────────
  const clusters: DuplicateCluster[] = dupKeys.map(d => {
    const [sup, art] = d.key.split('|')
    const members: ClusterMember[] = d.product_ids
      .map(pid => {
        const prod = productById.get(pid)
        return {
          product_id:         pid,
          product_name:       prod?.name ?? '(deleted product)',
          product_category:   prod?.category ?? null,
          archived_at:        prod?.archived_at ?? null,
          active_alias_count: aliasCountByPid.get(pid) ?? 0,
          recipe_use_count:   recipeCountByPid.get(pid) ?? 0,
          latest_invoice_date: d.latest_seen_by_pid.get(pid) ?? null,
        }
      })
      // Sort: active first, then recipe-use desc, then most-recent desc.
      // Owner usually wants to KEEP the one with the most attachments.
      .sort((a, b) => {
        const aArch = a.archived_at ? 1 : 0
        const bArch = b.archived_at ? 1 : 0
        if (aArch !== bArch) return aArch - bArch
        if (a.recipe_use_count !== b.recipe_use_count) return b.recipe_use_count - a.recipe_use_count
        return (b.latest_invoice_date ?? '').localeCompare(a.latest_invoice_date ?? '')
      })
    return {
      supplier_fortnox_number: sup,
      supplier_name:           d.supplier_name,
      article_number:          art,
      member_count:            members.length,
      members,
    }
  })
  // Largest clusters first — those are the highest-leverage cleanups.
  clusters.sort((a, b) => b.member_count - a.member_count)

  return NextResponse.json({
    business_id:               businessId,
    clusters,
    total_clusters:            clusters.length,
    total_affected_products:   allPids.length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

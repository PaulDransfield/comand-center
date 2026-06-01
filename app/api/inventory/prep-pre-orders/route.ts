// app/api/inventory/prep-pre-orders/route.ts
//
// GET   /api/inventory/prep-pre-orders?business_id=X&service_date=Y
//   List active pre-orders for a given service date. Used by the prep
//   page to fold pre-orders into the auto-fill math.
//
// POST  /api/inventory/prep-pre-orders
//   body { business_id, service_date, party_name?, party_size,
//          notes?, items: [{ recipe_id, qty }] }
//   Creates a pre-order. recipe_ids validated against the business
//   (rejects unknown / cross-tenant ids). Qty must be a positive integer.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ── GET ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const serviceDate = String(url.searchParams.get('service_date') ?? '').trim()
  if (!businessId)  return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!serviceDate) return NextResponse.json({ error: 'service_date required (YYYY-MM-DD)' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data, error } = await db
    .from('prep_pre_orders')
    .select('id, service_date, party_name, party_size, notes, items, created_at, updated_at')
    .eq('business_id', businessId)
    .eq('service_date', serviceDate)
    .is('archived_at', null)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ pre_orders: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── POST ───────────────────────────────────────────────────────────────
interface PostBody {
  business_id?:  string
  service_date?: string
  party_name?:   string | null
  party_size?:   number
  notes?:        string | null
  items?:        Array<{ recipe_id?: string; qty?: number }>
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime())
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: PostBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const businessId  = String(body.business_id  ?? '').trim()
  const serviceDate = String(body.service_date ?? '').trim()
  if (!businessId)  return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!isValidDate(serviceDate)) return NextResponse.json({ error: 'service_date must be YYYY-MM-DD' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const partySize = Math.floor(Number(body.party_size ?? 0))
  if (!Number.isFinite(partySize) || partySize <= 0) {
    return NextResponse.json({ error: 'party_size must be a positive integer' }, { status: 400 })
  }

  const rawItems = Array.isArray(body.items) ? body.items : []
  // Filter + normalise; reject if any item has bad qty (silent drop of
  // empty ids is fine — owner can re-pick).
  const items: Array<{ recipe_id: string; qty: number }> = []
  for (const it of rawItems) {
    const rid = String(it?.recipe_id ?? '').trim()
    const qty = Math.floor(Number(it?.qty ?? 0))
    if (!rid) continue
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: `qty must be a positive integer (got ${it?.qty} for recipe ${rid.slice(0, 8)})` }, { status: 400 })
    }
    items.push({ recipe_id: rid, qty })
  }

  const db = createAdminClient()

  // Cross-tenant guard: every recipe must belong to this business and
  // not be archived. Reject the whole pre-order if any id is unknown
  // (a partial save would hide the owner's mistake).
  if (items.length > 0) {
    const recipeIds = [...new Set(items.map(i => i.recipe_id))]
    const { data: recipes } = await db
      .from('recipes')
      .select('id')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .in('id', recipeIds)
    const knownIds = new Set((recipes ?? []).map(r => r.id))
    const unknown = recipeIds.filter(id => !knownIds.has(id))
    if (unknown.length > 0) {
      return NextResponse.json({
        error: `Unknown recipe ids: ${unknown.map(s => s.slice(0, 8)).join(', ')}`,
      }, { status: 400 })
    }
  }

  const { data, error } = await db
    .from('prep_pre_orders')
    .insert({
      org_id:       auth.orgId,
      business_id:  businessId,
      service_date: serviceDate,
      party_name:   body.party_name?.toString().trim() || null,
      party_size:   partySize,
      notes:        body.notes?.toString().trim() || null,
      items,
      created_by:   (auth as any).userId ?? null,
    })
    .select('id, service_date, party_name, party_size, notes, items, created_at, updated_at')
    .single()
  if (error || !data) return NextResponse.json({ error: error?.message ?? 'Failed to create pre-order' }, { status: 500 })

  return NextResponse.json({ pre_order: data }, { headers: { 'Cache-Control': 'no-store' } })
}

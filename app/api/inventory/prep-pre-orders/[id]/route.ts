// app/api/inventory/prep-pre-orders/[id]/route.ts
//
// PATCH  — edit fields on an existing pre-order (party_name, size,
//          notes, items, service_date)
// DELETE — soft delete (archived_at = NOW). Preserves audit history.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadPreOrder(db: any, id: string) {
  return db
    .from('prep_pre_orders')
    .select('id, business_id, service_date, party_name, party_size, notes, items, archived_at')
    .eq('id', id)
    .maybeSingle()
}

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime())
}

// ── PATCH ──────────────────────────────────────────────────────────────
interface PatchBody {
  service_date?: string
  party_name?:   string | null
  party_size?:   number
  notes?:        string | null
  items?:        Array<{ recipe_id?: string; qty?: number }>
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: PatchBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const db = createAdminClient()
  const { data: existing, error } = await loadPreOrder(db, params.id)
  if (error)     return NextResponse.json({ error: error.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Pre-order not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, existing.business_id)
  if (forbidden) return forbidden
  if (existing.archived_at) {
    return NextResponse.json({ error: 'Pre-order is archived — cannot edit' }, { status: 409 })
  }

  const patch: Record<string, any> = {}
  if (body.service_date !== undefined) {
    if (!isValidDate(body.service_date)) {
      return NextResponse.json({ error: 'service_date must be YYYY-MM-DD' }, { status: 400 })
    }
    patch.service_date = body.service_date
  }
  if (body.party_name !== undefined) {
    // H2: cap free-text input.
    patch.party_name = body.party_name?.toString().trim().slice(0, 200) || null
  }
  if (body.party_size !== undefined) {
    const ps = Math.floor(Number(body.party_size))
    // H2 + L8: positive int + sanity ceiling.
    if (!Number.isFinite(ps) || ps <= 0 || ps > 500) {
      return NextResponse.json({ error: 'party_size must be a positive integer ≤ 500' }, { status: 400 })
    }
    patch.party_size = ps
  }
  if (body.notes !== undefined) {
    // H2: cap free-text input.
    patch.notes = body.notes?.toString().trim().slice(0, 2000) || null
  }
  if (body.items !== undefined) {
    const rawItems = Array.isArray(body.items) ? body.items : []
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
    // Cross-tenant guard mirrors POST.
    if (items.length > 0) {
      const recipeIds = [...new Set(items.map(i => i.recipe_id))]
      const { data: recipes } = await db
        .from('recipes')
        .select('id')
        .eq('business_id', existing.business_id)
        .is('archived_at', null)
        .in('id', recipeIds)
      const knownIds = new Set((recipes ?? []).map((r: any) => r.id))
      const unknown = recipeIds.filter(id => !knownIds.has(id))
      if (unknown.length > 0) {
        return NextResponse.json({
          error: `Unknown recipe ids: ${unknown.map(s => s.slice(0, 8)).join(', ')}`,
        }, { status: 400 })
      }
    }
    patch.items = items
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ pre_order: existing }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const { data: updated, error: uErr } = await db
    .from('prep_pre_orders')
    .update(patch)
    .eq('id', existing.id)
    .select('id, service_date, party_name, party_size, notes, items, created_at, updated_at')
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ pre_order: updated }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── DELETE ─────────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: existing, error } = await loadPreOrder(db, params.id)
  if (error)     return NextResponse.json({ error: error.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Pre-order not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, existing.business_id)
  if (forbidden) return forbidden
  if (existing.archived_at) {
    // Already archived — treat as success (idempotent).
    return NextResponse.json({ ok: true })
  }

  const { error: dErr } = await db
    .from('prep_pre_orders')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', existing.id)
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}

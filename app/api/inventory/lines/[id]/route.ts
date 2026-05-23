// app/api/inventory/lines/[id]/route.ts
//
// PATCH — edit a single supplier_invoice_lines row. Used by the product
// detail page's inline price-history cells when the owner spots a bad
// number from PDF extraction.
//
// Editable: quantity, unit, price_per_unit, total_excl_vat.
//
// We do NOT touch raw_description here — fixing OCR description text
// would need a re-match (alias-link reshuffle) which is out of scope.
// To re-categorise a line, the owner should use /inventory/review on
// a needs_review line, or delete-and-re-extract the invoice.
//
// Auth: line.business_id → requireBusinessAccess
// Body: { quantity?, unit?, price_per_unit?, total_excl_vat? }
// Returns: { ok, line }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const patch: Record<string, any> = {}
  if (body.quantity !== undefined) {
    if (body.quantity === null || body.quantity === '') patch.quantity = null
    else {
      const q = Number(body.quantity)
      if (!Number.isFinite(q)) return NextResponse.json({ error: 'quantity must be a number' }, { status: 400 })
      patch.quantity = q
    }
  }
  if (body.unit !== undefined) patch.unit = body.unit ? String(body.unit).trim() : null
  if (body.price_per_unit !== undefined) {
    if (body.price_per_unit === null || body.price_per_unit === '') patch.price_per_unit = null
    else {
      const p = Number(body.price_per_unit)
      if (!Number.isFinite(p)) return NextResponse.json({ error: 'price_per_unit must be a number' }, { status: 400 })
      patch.price_per_unit = p
    }
  }
  if (body.total_excl_vat !== undefined) {
    const t = Number(body.total_excl_vat)
    if (!Number.isFinite(t)) return NextResponse.json({ error: 'total_excl_vat must be a number' }, { status: 400 })
    patch.total_excl_vat = t
  }
  if (body.currency !== undefined) {
    const c = String(body.currency).trim().toUpperCase()
    const valid = ['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP']
    if (!valid.includes(c)) return NextResponse.json({ error: `currency must be one of: ${valid.join(', ')}` }, { status: 400 })
    patch.currency = c
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 })
  }

  const db = createAdminClient()

  // Auth via the line's business_id
  const { data: line, error: lErr } = await db
    .from('supplier_invoice_lines')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
  if (!line) return NextResponse.json({ error: 'line not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, line.business_id)
  if (forbidden) return forbidden

  const { data, error } = await db
    .from('supplier_invoice_lines')
    .update(patch)
    .eq('id', params.id)
    .select('id, quantity, unit, price_per_unit, total_excl_vat, currency')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, line: data }, { headers: { 'Cache-Control': 'no-store' } })
}

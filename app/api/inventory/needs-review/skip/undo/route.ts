// app/api/inventory/needs-review/skip/undo/route.ts
//
// POST — owner clicked Undo on a card they just skipped. Flips the
// matching not_inventory lines back to needs_review so they re-appear
// in the queue on next reload.
//
// Body: { business_id, group_key }
// Returns: { ok, lines_restored }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { normaliseDescription } from '@/lib/inventory/normalise'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const groupKey   = String(body.group_key   ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!groupKey)   return NextResponse.json({ error: 'group_key required' },   { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  let supplierFortnoxNumber: string
  let normalisedTarget:      string
  let unitTarget:            string
  try {
    const decoded = Buffer.from(groupKey, 'base64url').toString('utf-8')
    const parts = decoded.split('\x1f')
    if (parts.length !== 3) throw new Error('bad part count')
    supplierFortnoxNumber = parts[0]
    normalisedTarget      = parts[1]
    unitTarget            = parts[2]
  } catch {
    return NextResponse.json({ error: 'group_key invalid' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: candidates, error } = await db
    .from('supplier_invoice_lines')
    .select('id, raw_description, unit')
    .eq('business_id', businessId)
    .eq('supplier_fortnox_number', supplierFortnoxNumber)
    .eq('match_status', 'not_inventory')
    .limit(5000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, lines_restored: 0 })
  }

  const matching = candidates.filter((l: any) =>
    normaliseDescription(l.raw_description) === normalisedTarget &&
    (l.unit ?? '').trim().toLowerCase() === unitTarget
  )
  if (matching.length === 0) {
    return NextResponse.json({ ok: true, lines_restored: 0 })
  }

  const ids = matching.map((l: any) => l.id)
  let restored = 0
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500)
    const { data: upd, error: uErr } = await db
      .from('supplier_invoice_lines')
      .update({ match_status: 'needs_review' })
      .in('id', slice)
      .select('id')
    if (uErr) return NextResponse.json({
      ok: false, lines_restored: restored, error: `update failed: ${uErr.message}`,
    }, { status: 500 })
    restored += upd?.length ?? 0
  }

  return NextResponse.json({
    ok: true,
    lines_restored: restored,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

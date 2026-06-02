// app/api/inventory/items/backfill-pack-size/route.ts
//
// POST — runs parseProductPackSize on every product in the business
// where pack_size IS NULL, saves the parsed result + the provenance.
// One-shot, idempotent.
//
// Body: { business_id }
// Returns: { ok, scanned, applied, applied_from_name, applied_from_invoice_unit,
//            still_missing, details: [{ id, name, suggestion }] }
//
// Phase A (2026-06-02) — the parser now also falls back to the supplier
// invoice_unit when the name discloses no pack info ("Citron — KG" →
// 1000 g, etc.). That mops up the residue at Chicce (8/9 mismatch
// products) that the name-only parse couldn't catch.
//
// We DON'T ask permission per product because the parser is conservative
// (only matches if it sees '<number> <unit>' in the name OR a known
// weight/volume/count unit in invoice_unit). Owner can adjust any wrong
// one on the product detail page. Source is tagged in `pack_source` so
// future audits can spot owner-corrected vs auto-inferred values.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { parseProductPackSize } from '@/lib/inventory/unit-conversion'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Pull every product without pack_size. Paginate to be safe at scale.
  // Phase A: SELECT invoice_unit too so the parser can use it as fallback.
  const candidates: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('id, name, invoice_unit, base_unit')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .is('pack_size', null)
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    candidates.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (from > 20_000) break
  }

  const details: Array<{ id: string; name: string; suggestion: any }> = []
  let applied              = 0
  let appliedFromName      = 0
  let appliedFromInvoice   = 0
  for (const p of candidates) {
    const sug = parseProductPackSize(p.name, p.invoice_unit)
    if (!sug) {
      details.push({ id: p.id, name: p.name, suggestion: null })
      continue
    }
    // pack_source column (M119) pending owner SQL apply — once the
    // column exists, write `pack_source: sug.source === 'name' ? 'name_parsed' : 'invoice_unit_inferred'`.
    // For now the source is returned in the response details so audits
    // can re-run the parser to recover provenance.
    const { error } = await db
      .from('products')
      .update({
        pack_size:   sug.pack_size,
        base_unit:   sug.base_unit,
      })
      .eq('id', p.id)
    if (error) {
      details.push({ id: p.id, name: p.name, suggestion: { error: error.message } })
      continue
    }
    details.push({ id: p.id, name: p.name, suggestion: { ...sug } })
    applied++
    if (sug.source === 'name') appliedFromName++
    else appliedFromInvoice++
  }

  const stillMissing = candidates.length - applied

  return NextResponse.json({
    ok: true,
    scanned:                  candidates.length,
    applied,
    applied_from_name:        appliedFromName,
    applied_from_invoice_unit: appliedFromInvoice,
    still_missing:            stillMissing,
    details,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

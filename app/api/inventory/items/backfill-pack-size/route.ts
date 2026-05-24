// app/api/inventory/items/backfill-pack-size/route.ts
//
// POST — runs parseProductPackSize on every product in the business
// where pack_size IS NULL, saves the parsed result. One-shot, idempotent.
//
// Body: { business_id }
// Returns: { ok, scanned, suggested, applied, details: [{ id, name, suggestion }] }
//
// "suggested" is the count of products where the parser could infer
// something. "applied" is the same number — we don't ask permission per
// product because the parser is conservative (only matches if it sees
// '<number> <unit>' in the name). Owner can adjust any wrong one on
// the product detail page.

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
  const candidates: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('id, name')
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
  let applied = 0
  for (const p of candidates) {
    const sug = parseProductPackSize(p.name)
    if (!sug) continue
    const { error } = await db
      .from('products')
      .update({ pack_size: sug.pack_size, base_unit: sug.base_unit })
      .eq('id', p.id)
    if (error) {
      details.push({ id: p.id, name: p.name, suggestion: { error: error.message } })
      continue
    }
    details.push({ id: p.id, name: p.name, suggestion: sug })
    applied++
  }

  return NextResponse.json({
    ok: true,
    scanned:   candidates.length,
    suggested: details.filter(d => !d.suggestion.error).length,
    applied,
    details,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

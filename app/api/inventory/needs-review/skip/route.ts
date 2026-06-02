// app/api/inventory/needs-review/skip/route.ts
//
// POST — owner clicks "Skip — overhead" on a bulk-review group. Re-flags
// every matching needs_review line as match_status='not_inventory' so
// the group disappears from the review queue. No product created.
//
// Used for rent / electricity / SaaS / laundry / waste-collection lines
// where the supplier-name classifier didn't match a non-inventory rule
// and Fortnox didn't post a BAS account.
//
// Idempotent: matching by (business, supplier, normalised_description,
// unit) means re-running picks up freshly-extracted lines from the same
// group on subsequent invoices.

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
    .eq('match_status', 'needs_review')
    .limit(5000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, lines_skipped: 0, message: 'No matching lines' })
  }

  const matching = candidates.filter((l: any) =>
    normaliseDescription(l.raw_description) === normalisedTarget &&
    (l.unit ?? '').trim().toLowerCase() === unitTarget
  )
  if (matching.length === 0) {
    return NextResponse.json({ ok: true, lines_skipped: 0, message: 'No matching lines' })
  }

  const ids = matching.map((l: any) => l.id)
  let updated = 0
  // BATCH_IN=100: 500-UUID .in() blows past Supabase's 16 KB header cap;
  // see docs/investigation/no-price-root-cause.md.
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100)
    const { data, error: uErr } = await db
      .from('supplier_invoice_lines')
      .update({ match_status: 'not_inventory' })
      .in('id', slice)
      .select('id')
    if (uErr) {
      return NextResponse.json({
        ok: false,
        lines_skipped: updated,
        error: `partial: ${uErr.message}`,
      }, { status: 500 })
    }
    updated += data?.length ?? 0
  }

  return NextResponse.json({
    ok: true,
    lines_skipped: updated,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// app/api/overheads/backfill/route.ts
//
// One-time bulk-essential backfill so an established business doesn't get
// drowned in flags on first run.
//
// POST { business_id, months?: 12 }
//
// Reads all unique normalised supplier names from tracker_line_items
// (category='other_cost') for the business in the last N months. For each
// supplier with no existing classification, inserts overhead_classifications
// with status='essential', backfill=true, baseline_avg_sek = avg of non-zero
// monthly totals.
//
// Then resolves any pending overhead_flags rows for those suppliers as
// 'accepted' (since the owner just declared them essential).
//
// Returns { suppliers_marked_essential, flags_resolved, already_classified }.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { normaliseSupplier, pickDisplayLabel } from '@/lib/overheads/normalise'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any = {}
  try { body = await req.json() } catch {}

  const businessId = typeof body?.business_id === 'string' ? body.business_id : null
  const months     = Math.max(1, Math.min(parseInt(String(body?.months ?? 12), 10) || 12, 36))
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Verify business belongs to caller's org.
  const { data: biz, error: bErr } = await db
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 })
  if (!biz) return NextResponse.json({ error: 'business not found in your org' }, { status: 404 })

  // ── Compute the rolling-N-months window ─────────────────────────────────
  const now      = new Date()
  const endY     = now.getFullYear()
  const endM     = now.getMonth() + 1
  let   startY   = endY
  let   startM   = endM - months + 1
  while (startM < 1) { startM += 12; startY -= 1 }

  // Single query, filter the partial-year edges in JS.
  const { data: lines, error: lErr } = await db
    .from('tracker_line_items')
    .select('label_sv, label_en, amount, period_year, period_month, fortnox_account')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('category', 'other_cost')
    .gte('period_year', startY)
    .lte('period_year', endY)
    .limit(50_000)
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })

  // Aggregate amount-by-supplier-by-month (for baseline avg).
  type AggKey = string  // normalised supplier name
  type Monthly = { display: string; perMonth: Map<string, number> }
  const agg = new Map<AggKey, Monthly>()
  for (const ln of (lines ?? []) as any[]) {
    // Edge filters: trim to the rolling window.
    if (ln.period_year === startY && ln.period_month < startM) continue
    if (ln.period_year === endY   && ln.period_month > endM)   continue

    const display = pickDisplayLabel(ln)
    const key     = normaliseSupplier(display)
    if (!key) continue

    const monthKey = `${ln.period_year}-${ln.period_month}`
    const cur = agg.get(key) ?? { display, perMonth: new Map<string, number>() }
    cur.perMonth.set(monthKey, (cur.perMonth.get(monthKey) ?? 0) + Number(ln.amount ?? 0))
    agg.set(key, cur)
  }

  if (agg.size === 0) {
    return NextResponse.json({
      suppliers_marked_essential: 0,
      flags_resolved:             0,
      already_classified:         0,
      window: { from: { year: startY, month: startM }, to: { year: endY, month: endM } },
    })
  }

  // Load existing classifications so we can skip already-decided suppliers.
  const { data: existing, error: eErr } = await db
    .from('overhead_classifications')
    .select('supplier_name_normalised')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
  if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 })
  const existingSet = new Set((existing ?? []).map((r: any) => r.supplier_name_normalised))

  // Build the upsert rows: only suppliers without an existing classification.
  const rowsToInsert: any[] = []
  let alreadyClassified = 0
  for (const [key, m] of agg) {
    if (existingSet.has(key)) { alreadyClassified++; continue }
    const nonZero = Array.from(m.perMonth.values()).filter(v => v > 0)
    const baseline = nonZero.length > 0
      ? nonZero.reduce((s, v) => s + v, 0) / nonZero.length
      : 0
    rowsToInsert.push({
      org_id:                   auth.orgId,
      business_id:              businessId,
      supplier_name:            m.display,
      supplier_name_normalised: key,
      status:                   'essential',
      decided_by:               auth.userId,
      decided_at:               new Date().toISOString(),
      reason:                   `Backfill: marked essential during initial review of last ${months} months.`,
      baseline_avg_sek:         Math.round(baseline * 100) / 100,
      baseline_set_at:          new Date().toISOString(),
      backfill:                 true,
    })
  }

  let suppliersMarked = 0
  if (rowsToInsert.length > 0) {
    const { error: iErr, count } = await db
      .from('overhead_classifications')
      .insert(rowsToInsert, { count: 'exact' })
    if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })
    suppliersMarked = count ?? rowsToInsert.length
  }

  // Resolve any pending flags whose supplier we just classified as essential.
  const newlyEssentialKeys = rowsToInsert.map(r => r.supplier_name_normalised)
  let flagsResolved = 0
  if (newlyEssentialKeys.length > 0) {
    const { error: fErr, count } = await db
      .from('overhead_flags')
      .update({
        resolution_status: 'accepted',
        resolved_at:       new Date().toISOString(),
        resolved_by:       auth.userId,
      }, { count: 'exact' })
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('resolution_status', 'pending')
      .in('supplier_name_normalised', newlyEssentialKeys)
    if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })
    flagsResolved = count ?? 0
  }

  return NextResponse.json({
    suppliers_marked_essential: suppliersMarked,
    flags_resolved:             flagsResolved,
    already_classified:         alreadyClassified,
    window: { from: { year: startY, month: startM }, to: { year: endY, month: endM } },
  })
}

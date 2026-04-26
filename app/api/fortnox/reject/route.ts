// app/api/fortnox/reject/route.ts
//
// Flips a fortnox_upload to status='rejected' and unwinds any data it wrote.
// PDF stays in storage (audit trail). The user can then re-upload the
// corrected file and apply() will write fresh data — no orphan rows.
//
// Symmetric with apply()'s supersede path: line items are cleaned by
// source_upload_id (not by period_month) so multi-month / annual uploads
// fully unwind. Pre-FIXES.md §0n this filter dropped only single-month
// rows and silently left annual line items behind forever.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { upload_id } = await req.json().catch(() => ({} as any))
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, period_year, period_month, status, doc_type, extracted_json')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })

  let affectedYears: number[] = []

  if (upload.status === 'applied') {
    // Collect every (year, month) this upload touched so we can re-aggregate
    // them after wiping. Multi-month uploads list periods explicitly in
    // extracted_json; single-month uploads have one (period_year, period_month).
    const touchedPeriods: Array<{ year: number; month: number }> = []
    const periods = Array.isArray(upload.extracted_json?.periods) ? upload.extracted_json.periods : []
    if (periods.length > 1) {
      for (const p of periods) {
        const y = Number(p?.year), m = Number(p?.month)
        if (y && m) touchedPeriods.push({ year: y, month: m })
      }
    } else if (upload.period_year && upload.period_month) {
      touchedPeriods.push({ year: upload.period_year, month: upload.period_month })
    } else if (upload.period_year && upload.doc_type === 'pnl_annual') {
      // Annual = month 0 convention for line items.
      touchedPeriods.push({ year: upload.period_year, month: 0 })
    }

    // ── Wipe line items by source_upload_id (no period_month filter) ─────
    // Catches multi-month uploads that previous code silently left behind.
    await db.from('tracker_line_items')
      .delete()
      .eq('source_upload_id', upload.id)

    // ── Clear tracker_data rows that came from THIS upload ───────────────
    // Use fortnox_upload_id as the discriminator so manual entries aren't
    // touched. Resets source to 'manual' and zeros the Fortnox-derived
    // overhead/depreciation/financial columns. revenue/food/staff stay so
    // the row isn't dropped if the user wants to keep manual numbers.
    await db.from('tracker_data')
      .update({
        source:            'manual',
        fortnox_upload_id: null,
        other_cost:        0,
        depreciation:      0,
        financial:         0,
        alcohol_cost:      0,
      })
      .eq('fortnox_upload_id', upload.id)

    affectedYears = Array.from(new Set(touchedPeriods.map(p => p.year)))
  }

  // If this upload was itself superseding a prior one, walk the chain back —
  // the predecessor returns to 'applied' so the rejected upload's data is
  // replaced by the prior version's data, not by a hole.
  if (upload.status === 'applied') {
    const { data: predecessor } = await db
      .from('fortnox_uploads')
      .select('id')
      .eq('superseded_by_id', upload.id)
      .maybeSingle()
    if (predecessor?.id) {
      await db.from('fortnox_uploads')
        .update({ status: 'applied', superseded_by_id: null })
        .eq('id', predecessor.id)
      // Re-apply the predecessor's data so tracker_data + line items reflect it.
      try {
        const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
        await fetch(`${base}/api/fortnox/apply`, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie':       req.headers.get('cookie') ?? '',
          },
          body: JSON.stringify({ upload_id: predecessor.id }),
        }).catch(() => {})
      } catch { /* non-fatal — admin can re-apply manually */ }
    }
  }

  await db.from('fortnox_uploads').update({
    status:           'rejected',
    applied_at:       null,
    superseded_by_id: null,
  }).eq('id', upload.id)

  // Re-aggregate every affected year so monthly_metrics drops the rejected
  // upload's contribution. Without this, dashboards can show ghost numbers
  // for hours after a rejection until the next nightly aggregator pass.
  if (affectedYears.length) {
    try {
      const { aggregateMetrics } = await import('@/lib/sync/aggregate')
      for (const year of affectedYears) {
        aggregateMetrics(auth.orgId, upload.business_id, `${year}-01-01`, `${year}-12-31`)
          .catch((e: any) => console.warn('[fortnox/reject] re-aggregate failed:', e?.message))
      }
    } catch { /* non-fatal */ }
  }

  return NextResponse.json({ ok: true, affected_years: affectedYears })
}

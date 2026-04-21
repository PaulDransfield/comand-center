// app/api/fortnox/apply/route.ts
//
// Commits an extracted Fortnox upload into the live tracker_data + the
// tracker_line_items detail table.  Period-scoped replacement: any
// existing line items for the same (business, year, month) get deleted
// first so re-apply is idempotent and future Fortnox API syncs can
// replace PDF data without duplicates.
//
// Annual reports (pnl_annual) don't touch tracker_data — we keep them as
// a reference-only extraction that the /overheads page renders as a
// yearly summary.  Monthly P&Ls upsert tracker_data via the unique
// (org, business, year, month) index added in the migration.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const { upload_id, overrides } = body as { upload_id?: string; overrides?: any }
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, doc_type, period_year, period_month, extracted_json, status')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
  if (upload.status !== 'extracted') {
    return NextResponse.json({ error: `Cannot apply — upload is ${upload.status}` }, { status: 400 })
  }

  const extraction = (overrides ?? upload.extracted_json) as any
  if (!extraction) return NextResponse.json({ error: 'No extraction data' }, { status: 400 })

  const year  = upload.period_year  ?? extraction?.period?.year
  const month = upload.period_month ?? extraction?.period?.month
  const isAnnual = upload.doc_type === 'pnl_annual'

  // Guard: monthly uploads need a month; annual uploads keep month null.
  if (!isAnnual && !month) {
    return NextResponse.json({ error: 'Monthly upload missing period_month' }, { status: 400 })
  }
  if (!year) return NextResponse.json({ error: 'Upload missing period_year' }, { status: 400 })

  // ── Annual: no tracker_data write.  Store line items only (month = 0
  //    convention so we can query them separately).  Keeps the yearly
  //    reference visible on /overheads without polluting the monthly
  //    tracker P&L view.
  if (isAnnual) {
    // Wipe any prior annual lines for this year+biz to keep idempotent.
    await db.from('tracker_line_items')
      .delete()
      .eq('org_id', auth.orgId)
      .eq('business_id', upload.business_id)
      .eq('period_year', year)
      .eq('period_month', 0)

    const lines = Array.isArray(extraction.lines) ? extraction.lines : []
    if (lines.length) {
      const rows = lines.map((l: any) => ({
        org_id:           auth.orgId,
        business_id:      upload.business_id,
        period_year:      year,
        period_month:     0,
        label_sv:         l.label_sv ?? l.label ?? '',
        label_en:         l.label_en ?? null,
        category:         l.category ?? 'other_cost',
        subcategory:      l.subcategory ?? null,
        amount:           Number(l.amount) || 0,
        fortnox_account:  l.fortnox_account ?? null,
        source_upload_id: upload.id,
      }))
      const { error: insErr } = await db.from('tracker_line_items').insert(rows)
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })
    }

    await db.from('fortnox_uploads').update({
      status:     'applied',
      applied_at: new Date().toISOString(),
      applied_by: auth.userId,
    }).eq('id', upload.id)

    return NextResponse.json({ ok: true, applied: { kind: 'annual', year, line_count: lines.length } })
  }

  // ── Monthly: upsert tracker_data + replace line items ──────────────────
  const rollup = extraction.rollup ?? {}
  const revenue     = Number(rollup.revenue     ?? 0) || 0
  const food_cost   = Number(rollup.food_cost   ?? 0) || 0
  const staff_cost  = Number(rollup.staff_cost  ?? 0) || 0
  const other_cost  = Number(rollup.other_cost  ?? 0) || 0
  const depreciation= Number(rollup.depreciation?? 0) || 0
  const financial   = Number(rollup.financial   ?? 0) || 0
  const net_profit  = Number.isFinite(Number(rollup.net_profit))
    ? Number(rollup.net_profit)
    : (revenue - food_cost - staff_cost - other_cost - depreciation + financial)
  const margin_pct  = revenue > 0 ? Math.round(((net_profit / revenue) * 100) * 10) / 10 : 0

  // Upsert via unique index — one row per (org, biz, year, month).
  const { data: upserted, error: upErr } = await db
    .from('tracker_data')
    .upsert({
      org_id:            auth.orgId,
      business_id:       upload.business_id,
      period_year:       year,
      period_month:      month,
      revenue, food_cost, staff_cost, net_profit, margin_pct,
      other_cost,
      source:            'fortnox_pdf',
      fortnox_upload_id: upload.id,
    }, { onConflict: 'org_id,business_id,period_year,period_month' })
    .select('id')
    .single()
  if (upErr || !upserted) {
    return NextResponse.json({ error: `tracker_data upsert failed: ${upErr?.message}` }, { status: 500 })
  }

  // Replace line items for this period.
  await db.from('tracker_line_items')
    .delete()
    .eq('org_id', auth.orgId)
    .eq('business_id', upload.business_id)
    .eq('period_year', year)
    .eq('period_month', month)

  const lines = Array.isArray(extraction.lines) ? extraction.lines : []
  if (lines.length) {
    const rows = lines.map((l: any) => ({
      org_id:           auth.orgId,
      business_id:      upload.business_id,
      tracker_data_id:  upserted.id,
      period_year:      year,
      period_month:     month,
      label_sv:         l.label_sv ?? l.label ?? '',
      label_en:         l.label_en ?? null,
      category:         l.category ?? 'other_cost',
      subcategory:      l.subcategory ?? null,
      amount:           Number(l.amount) || 0,
      fortnox_account:  l.fortnox_account ?? null,
      source_upload_id: upload.id,
    }))
    const { error: liErr } = await db.from('tracker_line_items').insert(rows)
    if (liErr) return NextResponse.json({ error: `line items insert failed: ${liErr.message}` }, { status: 500 })
  }

  await db.from('fortnox_uploads').update({
    status:     'applied',
    applied_at: new Date().toISOString(),
    applied_by: auth.userId,
  }).eq('id', upload.id)

  return NextResponse.json({
    ok: true,
    applied: {
      kind:           'monthly',
      year, month,
      tracker_data_id: upserted.id,
      line_count:      lines.length,
      rollup:          { revenue, food_cost, staff_cost, other_cost, net_profit, margin_pct },
    },
  })
}

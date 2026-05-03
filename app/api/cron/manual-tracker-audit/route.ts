// @ts-nocheck
// app/api/cron/manual-tracker-audit/route.ts
//
// Daily 06:45 UTC sentinel. Finds tracker_data rows that look suspicious:
//
//   - source = 'manual' AND fortnox_upload_id IS NULL
//     (the Rosali March 2026 case — owner says they didn't enter it but
//     a row appeared anyway)
//
//   - created_via IS NULL OR 'unknown'
//     (legacy or unattributed writes — flag so we can fix the source)
//
// Either signal points to a write path that bypassed the validated
// /api/fortnox/apply pipeline. Email ops with a digest if any new ones
// in the last 24h.
//
// Schedule in vercel.json: '45 6 * * *' (after master-sync 05:00 +
// anomaly-check 05:30 + health-check 06:00 + disagreements-alert 06:30).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { log }                       from '@/lib/log/structured'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60

const OPS_EMAIL = process.env.OPS_EMAIL ?? 'paul@comandcenter.se'

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}
export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}

async function run() {
  const started = Date.now()
  const db      = createAdminClient()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Suspicious row pattern:
  //   source = 'manual' AND fortnox_upload_id IS NULL
  //   AND created_at >= since24h
  //
  // We deliberately don't exclude `created_via='owner_form'` yet — if
  // the /tracker page UI ever starts populating that tag, we can add
  // the exclusion. For now, EVERY manual write without an upload is
  // worth surfacing.
  const { data: rows, error } = await db
    .from('tracker_data')
    .select('id, org_id, business_id, period_year, period_month, revenue, staff_cost, food_cost, source, created_via, created_at')
    .eq('source', 'manual')
    .is('fortnox_upload_id', null)
    .gte('created_at', since24h)
    .order('created_at', { ascending: false })
    .limit(200)
  if (error) {
    log.error('manual-tracker-audit: query failed', { error: error.message })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  if (!rows || rows.length === 0) {
    log.info('manual-tracker-audit: clean run', {
      route:       'cron/manual-tracker-audit',
      duration_ms: Date.now() - started,
      total:       0,
      status:      'success',
    })
    return NextResponse.json({ ok: true, sent: false, reason: 'no_suspicious_rows' })
  }

  // Resolve names — small batches, one round-trip each.
  const orgIds = [...new Set(rows.map(r => r.org_id))]
  const bizIds = [...new Set(rows.map(r => r.business_id))]
  const [orgsRes, bizRes] = await Promise.all([
    db.from('organisations').select('id, name').in('id', orgIds),
    db.from('businesses').select('id, name').in('id', bizIds),
  ])
  const orgName = new Map((orgsRes.data ?? []).map((o: any) => [o.id, o.name]))
  const bizName = new Map((bizRes.data ?? []).map((b: any) => [b.id, b.name]))

  const reportDate = new Date().toISOString().slice(0, 10)
  const subject    = `[CC Ops] Manual tracker_data writes — ${reportDate} · ${rows.length} suspicious row${rows.length === 1 ? '' : 's'}`
  const html       = buildEmail({ reportDate, rows, orgName, bizName })

  if (!process.env.RESEND_API_KEY) {
    console.warn('[manual-tracker-audit] RESEND_API_KEY missing — report built but not sent')
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_key_missing', total: rows.length })
  }

  const { sendEmail } = await import('@/lib/email/send')
  const sendRes = await sendEmail({
    from:    'CommandCenter Ops <ops@comandcenter.se>',
    to:      OPS_EMAIL,
    subject,
    html,
    context: { kind: 'manual_tracker_audit', report_date: reportDate, total: rows.length },
  })

  if (!sendRes.ok) {
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_failed', status: sendRes.status }, { status: 502 })
  }

  log.info('manual-tracker-audit sent', {
    route:       'cron/manual-tracker-audit',
    duration_ms: Date.now() - started,
    total:       rows.length,
    status:      'success',
  })

  return NextResponse.json({
    ok:        true,
    sent:      true,
    recipient: OPS_EMAIL,
    total:     rows.length,
  })
}

function buildEmail(d: { reportDate: string; rows: any[]; orgName: Map<string, string>; bizName: Map<string, string> }): string {
  const fmt = (n: number | null) => n == null ? '—' : Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'

  const rowsHtml = d.rows.map(r => `
    <tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:8px 10px;color:#111;">${escapeHtml(d.orgName.get(r.org_id) ?? r.org_id.slice(0,8))} · ${escapeHtml(d.bizName.get(r.business_id) ?? r.business_id.slice(0,8))}</td>
      <td style="padding:8px 10px;color:#374151;font-family:ui-monospace,monospace;">${r.period_year}-${String(r.period_month).padStart(2,'0')}</td>
      <td style="padding:8px 10px;color:#374151;text-align:right;">${escapeHtml(fmt(r.revenue))}</td>
      <td style="padding:8px 10px;color:#374151;text-align:right;">${escapeHtml(fmt(r.staff_cost))}</td>
      <td style="padding:8px 10px;color:#374151;text-align:right;">${escapeHtml(fmt(r.food_cost))}</td>
      <td style="padding:8px 10px;color:#9ca3af;font-size:11px;">${r.created_at?.slice(0,16)}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Manual tracker writes ${d.reportDate}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:780px;margin:24px auto;padding:28px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:14px;font-weight:700;color:#1a1f2e;margin-bottom:6px;">CommandCenter Ops · Manual tracker_data writes</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:20px;">${d.reportDate} · last 24h · <strong>${d.rows.length}</strong> suspicious row${d.rows.length === 1 ? '' : 's'}</div>

    <p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 18px;">
      The following <code>tracker_data</code> rows were written with <code>source='manual'</code> AND no <code>fortnox_upload_id</code>. They bypassed the validated /api/fortnox/apply pipeline. Investigate where the write came from and either correct or delete.
    </p>

    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
          <th style="padding:8px 10px;text-align:left;color:#6b7280;font-weight:600;">Customer</th>
          <th style="padding:8px 10px;text-align:left;color:#6b7280;font-weight:600;">Period</th>
          <th style="padding:8px 10px;text-align:right;color:#6b7280;font-weight:600;">Revenue</th>
          <th style="padding:8px 10px;text-align:right;color:#6b7280;font-weight:600;">Staff</th>
          <th style="padding:8px 10px;text-align:right;color:#6b7280;font-weight:600;">Food</th>
          <th style="padding:8px 10px;text-align:left;color:#6b7280;font-weight:600;">Created</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

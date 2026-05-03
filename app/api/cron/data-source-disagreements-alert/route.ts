// @ts-nocheck
// app/api/cron/data-source-disagreements-alert/route.ts
//
// Daily 06:30 UTC ops email. Checks every monthly_metrics row updated
// in the last 24 h for "data-source disagreement" markers
// (cost_source / rev_source values that mean PK and Fortnox — or any
// future POS — produced materially different numbers for the same
// period). Emails ops if any are present.
//
// Source-agnostic on purpose: the moment Caspeco / Onslip / Ancon land
// with their own dedup paths producing similar `_disagrees` codes, this
// alert pipeline picks them up. No per-integration code.
//
// Recipient: OPS_EMAIL env var (fallback paul@comandcenter.se).
// Schedule in vercel.json: '30 6 * * *' (after master-sync at 05:00 +
// anomaly-check at 05:30 + health-check at 06:00).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { findDisagreements }         from '@/lib/admin/disagreements'
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

  // Look at any monthly_metrics row touched in the last 24h. The
  // aggregator runs daily via master-sync, so this catches anything
  // freshly mis-classified plus anything backfilled by an admin.
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { rows, byCategory } = await findDisagreements(db, { since: since24h })

  if (rows.length === 0) {
    log.info('disagreements-alert: clean run', {
      route:       'cron/data-source-disagreements-alert',
      duration_ms: Date.now() - started,
      total:       0,
      status:      'success',
    })
    return NextResponse.json({ ok: true, sent: false, reason: 'no_disagreements' })
  }

  const reportDate = new Date().toISOString().slice(0, 10)
  const html       = buildEmail({ reportDate, rows, byCategory })
  const subject    = `[CC Ops] Data disagreements — ${reportDate} · ${byCategory.critical} critical · ${byCategory.warning} warning`

  if (!process.env.RESEND_API_KEY) {
    console.warn('[disagreements-alert] RESEND_API_KEY missing — report built but not sent')
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_key_missing', total: rows.length, by_category: byCategory })
  }

  const { sendEmail } = await import('@/lib/email/send')
  const sendRes = await sendEmail({
    from:    'CommandCenter Ops <ops@comandcenter.se>',
    to:      OPS_EMAIL,
    subject,
    html,
    context: { kind: 'disagreements_alert', report_date: reportDate, total: rows.length },
  })

  if (!sendRes.ok) {
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_failed', status: sendRes.status }, { status: 502 })
  }

  log.info('disagreements-alert sent', {
    route:       'cron/data-source-disagreements-alert',
    duration_ms: Date.now() - started,
    total:       rows.length,
    critical:    byCategory.critical,
    warning:     byCategory.warning,
    status:      'success',
  })

  return NextResponse.json({
    ok:        true,
    sent:      true,
    recipient: OPS_EMAIL,
    total:     rows.length,
    by_category: byCategory,
  })
}

function buildEmail(d: { reportDate: string; rows: any[]; byCategory: any }): string {
  const critical = d.rows.filter(r => r.category === 'critical')
  const warning  = d.rows.filter(r => r.category === 'warning')

  const section = (title: string, items: any[], color: string) => items.length === 0 ? '' : `
    <div style="margin:0 0 24px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:${color};margin-bottom:8px;">${escapeHtml(title)} (${items.length})</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
            <th style="padding:8px 10px;text-align:left;color:#6b7280;font-weight:600;">Customer</th>
            <th style="padding:8px 10px;text-align:left;color:#6b7280;font-weight:600;">Period</th>
            <th style="padding:8px 10px;text-align:left;color:#6b7280;font-weight:600;">Detail</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(r => `
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px 10px;color:#111;">${escapeHtml(r.org_name ?? r.org_id.slice(0,8))} · ${escapeHtml(r.business_name ?? r.business_id.slice(0,8))}</td>
              <td style="padding:8px 10px;color:#374151;font-family:ui-monospace,monospace;">${r.year}-${String(r.month).padStart(2,'0')}</td>
              <td style="padding:8px 10px;color:#374151;">${escapeHtml(r.summary)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Data disagreements ${d.reportDate}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:720px;margin:24px auto;padding:28px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#1a1f2e;margin-bottom:6px;">CommandCenter Ops · Data disagreements</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:20px;">${d.reportDate} · last 24h · <strong>${d.byCategory.critical}</strong> critical · ${d.byCategory.warning} warning</div>

    <p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 18px;">
      The aggregator detected source mismatches on <strong>${d.rows.length}</strong> period${d.rows.length === 1 ? '' : 's'} in the last 24h. Critical = PK and Fortnox staff differ by &gt; 30 % (likely an unmapped workplace). Warning = a source had partial coverage (PK connected mid-period, POS missed days, etc.).
    </p>

    ${section('Critical · staff disagreement', critical, '#b91c1c')}
    ${section('Warning · partial coverage',     warning,  '#92400e')}

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">
      Investigate via <a href="https://www.comandcenter.se/admin/v2/customers" style="color:#6366f1;">/admin/v2/customers</a> or pull the full list at <a href="https://www.comandcenter.se/api/admin/data-disagreements?days=30" style="color:#6366f1;">/api/admin/data-disagreements</a>.
    </p>
  </div>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// @ts-nocheck
// app/api/cron/today-data-sentinel/route.ts
//
// Mid-day "today's data is silently zero" sentinel. Runs at 14:00 UTC
// (= 16:00 Stockholm CEST / 15:00 CET) — late enough that lunch shifts
// have logged hours, early enough that we have time to investigate
// before evening service.
//
// What it checks (per connected PK business):
//   1. Are there any staff_logs rows for TODAY (Stockholm date)?
//      If no, the business hasn't rostered shifts — skip, nothing to verify.
//   2. Does daily_metrics have a row for today with staff_cost > 0?
//      If yes, all good. If no (or staff_cost = 0), the aggregator
//      isn't picking up today's data and we email ops.
//
// This catches the whole class of "today's data silently absent" bugs:
//   - The 2026-05-08 scheduled-shift filter regression
//   - Future regressions where new staff_logs filters drop today
//   - Aggregator runtime failures that left the row empty
//   - Deploy-time issues where the aggregator wasn't called
//
// Intentionally source-agnostic: the moment a non-PK roster source
// (Caspeco, Quinyx, etc.) writes to staff_logs, the same check picks it
// up without code changes.
//
// Recipient: OPS_EMAIL env var (fallback paul@comandcenter.se).
// Schedule (vercel.json): '0 14 * * *' — daily 14:00 UTC.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { log }                       from '@/lib/log/structured'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60

const OPS_EMAIL = process.env.OPS_EMAIL ?? 'paul@comandcenter.se'

// Stockholm-local date as YYYY-MM-DD. Owners think in business-local days,
// not UTC; using a UTC slice would cross midnight wrong for one hour every
// summer (when Stockholm is UTC+2 and 23:00 UTC is already tomorrow locally).
function todayStockholm(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Stockholm',
    year:    'numeric',
    month:   '2-digit',
    day:     '2-digit',
  })
  return fmt.format(new Date())  // 'YYYY-MM-DD' from en-CA locale
}

interface Gap {
  org_id:        string
  org_name:      string | null
  business_id:   string
  business_name: string | null
  shifts_today:  number
  scheduled_only_today: number
  daily_row_present:    boolean
  staff_cost_today:     number
}

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
  const today   = todayStockholm()

  // 1. Every connected staff-roster integration. Personalkollen is the
  //    only one wired today; future Caspeco/Quinyx/etc. would land here.
  const { data: integrations, error: iErr } = await db
    .from('integrations')
    .select('org_id, business_id, provider, status')
    .eq('provider', 'personalkollen')
    .eq('status', 'connected')

  if (iErr) {
    log.error('today-data-sentinel: integrations query failed', {
      route:  'cron/today-data-sentinel',
      error:  iErr.message,
    })
    return NextResponse.json({ ok: false, error: iErr.message }, { status: 500 })
  }

  const businessIds = Array.from(new Set(
    (integrations ?? []).map(i => i.business_id).filter(Boolean) as string[]
  ))

  if (businessIds.length === 0) {
    log.info('today-data-sentinel: no connected PK businesses', {
      route:  'cron/today-data-sentinel',
      today,
    })
    return NextResponse.json({ ok: true, sent: false, reason: 'no_businesses' })
  }

  // 2. Pull today's staff_logs counts per business in one query.
  const { data: shiftRows, error: sErr } = await db
    .from('staff_logs')
    .select('business_id, pk_log_url')
    .eq('shift_date', today)
    .in('business_id', businessIds)
    .limit(50_000)

  if (sErr) {
    log.error('today-data-sentinel: staff_logs query failed', {
      route:  'cron/today-data-sentinel',
      error:  sErr.message,
    })
    return NextResponse.json({ ok: false, error: sErr.message }, { status: 500 })
  }

  // Tally shifts per business — split scheduled-vs-logged so the email
  // can show "12 shifts (8 scheduled, 4 logged)".
  const shiftCounts = new Map<string, { total: number; scheduled: number; logged: number }>()
  for (const row of shiftRows ?? []) {
    const bid = row.business_id as string
    if (!bid) continue
    const cur = shiftCounts.get(bid) ?? { total: 0, scheduled: 0, logged: 0 }
    cur.total += 1
    const isScheduled = typeof row.pk_log_url === 'string' && row.pk_log_url.endsWith('_scheduled')
    if (isScheduled) cur.scheduled += 1
    else             cur.logged    += 1
    shiftCounts.set(bid, cur)
  }

  // 3. Pull today's daily_metrics rows.
  const { data: dailyRows, error: dErr } = await db
    .from('daily_metrics')
    .select('business_id, staff_cost')
    .eq('date', today)
    .in('business_id', businessIds)

  if (dErr) {
    log.error('today-data-sentinel: daily_metrics query failed', {
      route:  'cron/today-data-sentinel',
      error:  dErr.message,
    })
    return NextResponse.json({ ok: false, error: dErr.message }, { status: 500 })
  }

  const dailyByBiz = new Map<string, number>()
  for (const r of dailyRows ?? []) dailyByBiz.set(r.business_id as string, Number(r.staff_cost ?? 0))

  // 4. Pull org + business names for the email.
  const { data: bizRows } = await db
    .from('businesses')
    .select('id, name, org_id')
    .in('id', businessIds)
  const bizById = new Map<string, { id: string; name: string; org_id: string }>()
  for (const b of bizRows ?? []) bizById.set(b.id as string, b as any)

  const orgIds = Array.from(new Set((bizRows ?? []).map(b => b.org_id as string).filter(Boolean)))
  const { data: orgRows } = orgIds.length
    ? await db.from('organisations').select('id, name').in('id', orgIds)
    : { data: [] as any[] }
  const orgById = new Map<string, string>()
  for (const o of orgRows ?? []) orgById.set(o.id as string, (o.name as string) ?? '')

  // 5. Compute gaps. A "gap" is: business has shifts today, but
  //    daily_metrics row for today is missing OR staff_cost = 0.
  const gaps: Gap[] = []
  for (const bid of businessIds) {
    const shifts = shiftCounts.get(bid)
    if (!shifts || shifts.total === 0) continue  // no roster, nothing to verify

    const staffCostToday = dailyByBiz.get(bid)
    const rowPresent     = dailyByBiz.has(bid)
    const ok             = rowPresent && (staffCostToday ?? 0) > 0
    if (ok) continue

    const biz = bizById.get(bid)
    gaps.push({
      org_id:               biz?.org_id ?? '',
      org_name:             biz ? (orgById.get(biz.org_id) ?? null) : null,
      business_id:          bid,
      business_name:        biz?.name ?? null,
      shifts_today:         shifts.total,
      scheduled_only_today: shifts.scheduled,
      daily_row_present:    rowPresent,
      staff_cost_today:     staffCostToday ?? 0,
    })
  }

  if (gaps.length === 0) {
    log.info('today-data-sentinel: clean run', {
      route:           'cron/today-data-sentinel',
      duration_ms:     Date.now() - started,
      today,
      businesses_checked: businessIds.length,
      status:          'success',
    })
    return NextResponse.json({
      ok: true, sent: false, reason: 'no_gaps', today,
      businesses_checked: businessIds.length,
    })
  }

  const html    = buildEmail({ today, gaps })
  const subject = `[CC Ops] Today data sentinel — ${today} · ${gaps.length} business${gaps.length === 1 ? '' : 'es'} with empty staff cost`

  if (!process.env.RESEND_API_KEY) {
    console.warn('[today-data-sentinel] RESEND_API_KEY missing — report built but not sent')
    return NextResponse.json({
      ok: false, sent: false, reason: 'resend_key_missing',
      today, gaps_count: gaps.length, gaps,
    })
  }

  const { sendEmail } = await import('@/lib/email/send')
  const sendRes = await sendEmail({
    from:    'CommandCenter Ops <ops@comandcenter.se>',
    to:      OPS_EMAIL,
    subject,
    html,
    context: { kind: 'today_data_sentinel', report_date: today, gaps_count: gaps.length },
  })

  if (!sendRes.ok) {
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_failed', status: sendRes.status }, { status: 502 })
  }

  log.warn('today-data-sentinel: gaps detected', {
    route:           'cron/today-data-sentinel',
    duration_ms:     Date.now() - started,
    today,
    businesses_checked: businessIds.length,
    gaps_count:      gaps.length,
    status:          'success',
  })

  return NextResponse.json({
    ok:        true,
    sent:      true,
    recipient: OPS_EMAIL,
    today,
    businesses_checked: businessIds.length,
    gaps_count: gaps.length,
  })
}

function buildEmail(d: { today: string; gaps: Gap[] }): string {
  const rows = d.gaps.map(g => {
    const orgLabel = escapeHtml(g.org_name ?? g.org_id.slice(0, 8))
    const bizLabel = escapeHtml(g.business_name ?? g.business_id.slice(0, 8))
    const dailyState = g.daily_row_present
      ? `row exists, staff_cost = <strong style="color:#b91c1c;">${g.staff_cost_today.toLocaleString('en-GB').replace(/,/g, ' ')} kr</strong>`
      : `<strong style="color:#b91c1c;">no daily_metrics row</strong>`
    const shiftLabel = g.scheduled_only_today === g.shifts_today
      ? `${g.shifts_today} shifts (all scheduled, none logged yet)`
      : `${g.shifts_today} shifts (${g.scheduled_only_today} scheduled · ${g.shifts_today - g.scheduled_only_today} logged)`
    return `
      <tr style="border-bottom:1px solid #f3f4f6;">
        <td style="padding:10px 12px;color:#111;">${orgLabel} · ${bizLabel}</td>
        <td style="padding:10px 12px;color:#374151;">${escapeHtml(shiftLabel)}</td>
        <td style="padding:10px 12px;color:#374151;">${dailyState}</td>
        <td style="padding:10px 12px;color:#374151;font-family:ui-monospace,monospace;font-size:11px;">
          <a href="https://www.comandcenter.se/api/admin/reaggregate?business_id=${escapeHtml(g.business_id)}&days=2"
             style="color:#6366f1;text-decoration:none;">re-aggregate</a>
        </td>
      </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Today data sentinel ${d.today}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;">
  <div style="max-width:780px;margin:24px auto;padding:28px;background:white;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.06);">
    <div style="font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#1a1f2e;margin-bottom:6px;">CommandCenter Ops · Today data sentinel</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:20px;">${d.today} (Stockholm) · <strong>${d.gaps.length}</strong> business${d.gaps.length === 1 ? '' : 'es'} with shifts but empty staff_cost</div>

    <p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 18px;">
      The aggregator found shifts in <code>staff_logs</code> for today but produced no
      <code>daily_metrics.staff_cost</code>. The owner's dashboard tile for today is reading 0.
      Most likely cause: a regression where scheduled-only rows are being filtered out at
      aggregation time. Confirmed pattern from 2026-05-08 — see CLAUDE.md Session 18 invariant.
      Hit "re-aggregate" below to refresh that business's daily_metrics from the existing
      staff_logs rows.
    </p>

    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;">Customer</th>
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;">Today's roster</th>
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;">daily_metrics state</th>
          <th style="padding:10px 12px;text-align:left;color:#6b7280;font-weight:600;">Action</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;">
    <p style="font-size:11px;color:#9ca3af;line-height:1.5;margin:0;">
      Runs daily at 14:00 UTC (16:00 Stockholm CEST / 15:00 CET). The check is source-agnostic — any roster integration that writes to <code>staff_logs</code> with <code>shift_date = today</code> is in scope. To suppress: disable the cron in <code>vercel.json</code>.
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

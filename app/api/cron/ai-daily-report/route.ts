// @ts-nocheck
// app/api/cron/ai-daily-report/route.ts
//
// Daily 08:00 UTC ops email. Summarises AI usage + cost for the last 24 h,
// flags any org with anomalous spending (≥ 2× its 7-day moving average),
// reports % of global kill-switch cap consumed.
//
// Recipient: OPS_EMAIL env var (fallback paul@comandcenter.se).
// Schedule in vercel.json: '0 8 * * *'.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { log }                       from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const OPS_EMAIL          = process.env.OPS_EMAIL ?? 'paul@comandcenter.se'
const GLOBAL_CAP_USD     = parseFloat(process.env.MAX_DAILY_GLOBAL_USD ?? '50') || 50
const ANOMALY_MULTIPLIER = 2

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
  const db = createAdminClient()
  const now      = new Date()
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const since7d  = new Date(now.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString()

  // Last 24h rows
  const { data: day } = await db
    .from('ai_request_log')
    .select('org_id, cost_usd, cost_sek, input_tokens, output_tokens, model, tier')
    .gte('created_at', since24h)

  // Last 7d rows (for moving-average comparison)
  const { data: week } = await db
    .from('ai_request_log')
    .select('org_id, cost_sek, created_at')
    .gte('created_at', since7d)

  const dayRows = day ?? []

  const sumDay = dayRows.reduce((a: any, r: any) => ({
    queries:  a.queries + 1,
    cost_usd: a.cost_usd + Number(r.cost_usd ?? 0),
    cost_sek: a.cost_sek + Number(r.cost_sek       ?? 0),
    tokens:   a.tokens + Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0),
  }), { queries: 0, cost_usd: 0, cost_sek: 0, tokens: 0 })

  const globalPct = Math.round((sumDay.cost_usd / GLOBAL_CAP_USD) * 100)

  // Per-org day + 7d average
  const byOrgDay: Record<string, { queries: number; cost_sek: number }> = {}
  for (const r of dayRows) {
    const k = r.org_id
    if (!byOrgDay[k]) byOrgDay[k] = { queries: 0, cost_sek: 0 }
    byOrgDay[k].queries  += 1
    byOrgDay[k].cost_sek += Number(r.cost_sek ?? 0)
  }

  const byOrgWeek: Record<string, { cost_sek: number; days: Set<string> }> = {}
  for (const r of (week ?? [])) {
    const k = r.org_id
    const d = (r.created_at ?? '').slice(0, 10)
    if (!byOrgWeek[k]) byOrgWeek[k] = { cost_sek: 0, days: new Set() }
    byOrgWeek[k].cost_sek += Number(r.cost_sek ?? 0)
    if (d) byOrgWeek[k].days.add(d)
  }

  // Enrich with org names
  const orgIds = [...new Set(Object.keys(byOrgDay).concat(Object.keys(byOrgWeek)))]
  const { data: orgs } = orgIds.length
    ? await db.from('organisations').select('id, name, plan').in('id', orgIds)
    : { data: [] }
  const orgMap = new Map((orgs ?? []).map((o: any) => [o.id, o]))

  // Build top spenders + anomaly list
  const topSpenders = Object.entries(byOrgDay)
    .map(([org_id, v]) => ({
      org_id,
      name:    (orgMap.get(org_id) as any)?.name ?? org_id.slice(0, 8),
      plan:    (orgMap.get(org_id) as any)?.plan ?? '—',
      queries: v.queries,
      cost_sek: Math.round(v.cost_sek * 100) / 100,
    }))
    .sort((a, b) => b.cost_sek - a.cost_sek)
    .slice(0, 5)

  const anomalies = Object.entries(byOrgDay)
    .map(([org_id, todayStats]) => {
      const weekStats = byOrgWeek[org_id]
      const avgDaily  = weekStats && weekStats.days.size > 0 ? weekStats.cost_sek / weekStats.days.size : 0
      const ratio     = avgDaily > 0 ? todayStats.cost_sek / avgDaily : null
      return {
        org_id,
        name: (orgMap.get(org_id) as any)?.name ?? org_id.slice(0, 8),
        today_sek: Math.round(todayStats.cost_sek * 100) / 100,
        avg_sek:   Math.round(avgDaily * 100) / 100,
        ratio:     ratio ? Math.round(ratio * 10) / 10 : null,
      }
    })
    .filter(a => a.ratio !== null && a.ratio >= ANOMALY_MULTIPLIER && a.today_sek > 0.5)
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
    .slice(0, 10)

  const reportDate = now.toISOString().slice(0, 10)
  const html = buildEmail({
    reportDate,
    sumDay,
    globalPct,
    globalCapUsd: GLOBAL_CAP_USD,
    topSpenders,
    anomalies,
  })

  // Send via Resend
  if (!process.env.RESEND_API_KEY) {
    console.warn('[ai-daily-report] RESEND_API_KEY missing — report built but not sent')
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_key_missing', summary: { sumDay, globalPct, anomalies: anomalies.length } })
  }

  const { sendEmail } = await import('@/lib/email/send')
  const sendRes = await sendEmail({
    from:    'CommandCenter Ops <ops@comandcenter.se>',
    to:      OPS_EMAIL,
    subject: `[CC Ops] AI daily — ${reportDate} · ${sumDay.queries} queries · ${sumDay.cost_sek.toFixed(2)} kr · global ${globalPct}%`,
    html,
    context: { kind: 'ai_daily_report', report_date: reportDate, queries: sumDay.queries },
  })

  if (!sendRes.ok) {
    return NextResponse.json({ ok: false, sent: false, reason: 'resend_failed', status: sendRes.status }, { status: 502 })
  }

  log.info('ai-daily-report sent', {
    route:       'cron/ai-daily-report',
    duration_ms: Date.now() - started,
    queries:     sumDay.queries,
    cost_sek:    Math.round(sumDay.cost_sek * 100) / 100,
    global_pct:  globalPct,
    anomalies:   anomalies.length,
    status:      'success',
  })
  return NextResponse.json({
    ok:         true,
    sent:       true,
    recipient:  OPS_EMAIL,
    queries:    sumDay.queries,
    cost_sek:   Math.round(sumDay.cost_sek * 100) / 100,
    cost_usd:   Math.round(sumDay.cost_usd * 10000) / 10000,
    global_pct: globalPct,
    top:        topSpenders.length,
    anomalies:  anomalies.length,
  })
}

function buildEmail(d: {
  reportDate:    string
  sumDay:        { queries: number; cost_usd: number; cost_sek: number; tokens: number }
  globalPct:     number
  globalCapUsd:  number
  topSpenders:   Array<{ name: string; plan: string; queries: number; cost_sek: number }>
  anomalies:     Array<{ name: string; today_sek: number; avg_sek: number; ratio: number | null }>
}): string {
  const capColor = d.globalPct >= 80 ? '#dc2626' : d.globalPct >= 50 ? '#d97706' : '#15803d'
  const spenderRows = d.topSpenders.length === 0
    ? `<tr><td colspan="4" style="padding:10px;color:#9ca3af">No AI calls in the last 24 h.</td></tr>`
    : d.topSpenders.map(s => `
        <tr>
          <td style="padding:8px 10px;color:#111;font-weight:500">${escapeHtml(s.name)}</td>
          <td style="padding:8px 10px;color:#6b7280;text-transform:uppercase;font-size:11px">${escapeHtml(s.plan)}</td>
          <td style="padding:8px 10px;text-align:right;color:#374151">${s.queries}</td>
          <td style="padding:8px 10px;text-align:right;color:#111;font-family:ui-monospace,monospace">${s.cost_sek.toFixed(2)} kr</td>
        </tr>`).join('')
  const anomalyRows = d.anomalies.length === 0
    ? `<tr><td colspan="4" style="padding:10px;color:#15803d">No anomalies — every org within 2× of its 7-day average.</td></tr>`
    : d.anomalies.map(a => `
        <tr>
          <td style="padding:8px 10px;color:#111;font-weight:500">${escapeHtml(a.name)}</td>
          <td style="padding:8px 10px;text-align:right;color:#dc2626;font-family:ui-monospace,monospace">${a.ratio?.toFixed(1) ?? '—'}×</td>
          <td style="padding:8px 10px;text-align:right;color:#374151;font-family:ui-monospace,monospace">${a.today_sek.toFixed(2)} kr</td>
          <td style="padding:8px 10px;text-align:right;color:#6b7280;font-family:ui-monospace,monospace">${a.avg_sek.toFixed(2)} kr avg</td>
        </tr>`).join('')

  return `
  <div style="font-family:system-ui,sans-serif;max-width:640px;margin:0 auto;padding:32px 20px;color:#111">
    <div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9ca3af">CommandCenter Ops</div>
    <h1 style="font-size:22px;font-weight:700;margin:2px 0 18px">AI usage — ${d.reportDate}</h1>

    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
      <div style="flex:1;min-width:140px;padding:12px 14px;background:#fafbff;border-radius:10px">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em">Queries 24h</div>
        <div style="font-size:22px;font-weight:800;margin-top:3px">${d.sumDay.queries}</div>
      </div>
      <div style="flex:1;min-width:140px;padding:12px 14px;background:#fafbff;border-radius:10px">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em">Cost 24h</div>
        <div style="font-size:22px;font-weight:800;margin-top:3px">${d.sumDay.cost_sek.toFixed(2)} kr</div>
        <div style="font-size:11px;color:#6b7280;margin-top:2px">$${d.sumDay.cost_usd.toFixed(4)} USD</div>
      </div>
      <div style="flex:1;min-width:140px;padding:12px 14px;background:#fafbff;border-radius:10px">
        <div style="font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em">Tokens</div>
        <div style="font-size:22px;font-weight:800;margin-top:3px">${d.sumDay.tokens.toLocaleString('en-GB')}</div>
      </div>
    </div>

    <div style="margin-bottom:20px;padding:12px 14px;background:#fafbff;border-radius:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#6b7280;margin-bottom:6px">
        <span>Global kill-switch — 24 h spend vs $${d.globalCapUsd} cap</span>
        <span style="color:${capColor};font-family:ui-monospace,monospace;font-weight:700">${d.globalPct}%</span>
      </div>
      <div style="width:100%;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
        <div style="width:${Math.min(100, d.globalPct)}%;height:100%;background:${capColor}"></div>
      </div>
    </div>

    <h2 style="font-size:14px;font-weight:700;margin:24px 0 8px">Top 5 spenders (24h)</h2>
    <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#f9fafb">
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Org</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Plan</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase">Queries</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase">Cost</th>
      </tr></thead>
      <tbody>${spenderRows}</tbody>
    </table>

    <h2 style="font-size:14px;font-weight:700;margin:24px 0 8px">Anomalies — orgs ≥ 2× their 7-day average</h2>
    <table style="width:100%;border-collapse:collapse;font-size:12px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#f9fafb">
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#9ca3af;text-transform:uppercase">Org</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase">Ratio</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase">Today</th>
        <th style="padding:8px 10px;text-align:right;font-size:10px;color:#9ca3af;text-transform:uppercase">Weekly avg</th>
      </tr></thead>
      <tbody>${anomalyRows}</tbody>
    </table>

    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
      Generated by /api/cron/ai-daily-report · Global cap env: MAX_DAILY_GLOBAL_USD=${d.globalCapUsd}
    </div>
  </div>`
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

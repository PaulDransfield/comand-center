// app/api/tracker/accountant-summary/route.ts
//
// Generates a one-page HTML summary for a month — rollup + line items +
// notes — that the owner can forward to their bookkeeper.  Replaces the
// "send me the numbers for March" back-and-forth.
//
// GET /api/tracker/accountant-summary?business_id=...&year=YYYY&month=M
// Returns text/html (opens directly in a new tab for print or copy).
//
// The narrative text comes from the existing /api/tracker/narrative route,
// which already reads SCOPE_NOTE.  We don't re-call it here — the summary
// is deliberately data-only + formatted for a human reviewer.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function kr(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return (Math.round(n * 10) / 10).toFixed(1) + '%'
}
function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
}

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const year       = Number(u.searchParams.get('year')  ?? new Date().getFullYear())
  const month      = Number(u.searchParams.get('month') ?? (new Date().getMonth() + 1))
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Pull the pieces
  const [bizRes, tdRes, mmRes, liRes] = await Promise.all([
    db.from('businesses').select('name, city').eq('id', businessId).eq('org_id', auth.orgId).maybeSingle(),
    db.from('tracker_data').select('*').eq('org_id', auth.orgId).eq('business_id', businessId).eq('period_year', year).eq('period_month', month).maybeSingle(),
    db.from('monthly_metrics').select('*').eq('org_id', auth.orgId).eq('business_id', businessId).eq('year', year).eq('month', month).maybeSingle(),
    db.from('tracker_line_items').select('label_sv, category, subcategory, amount, fortnox_account').eq('org_id', auth.orgId).eq('business_id', businessId).eq('period_year', year).eq('period_month', month).order('amount', { ascending: false }),
  ])

  const biz = bizRes.data
  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })
  const td  = tdRes.data
  const mm  = mmRes.data
  const li  = liRes.data ?? []

  // Group line items by category for the report
  const byCat: Record<string, any[]> = {}
  for (const l of li) {
    if (!byCat[l.category]) byCat[l.category] = []
    byCat[l.category].push(l)
  }

  const revenue    = Number(mm?.revenue    ?? td?.revenue    ?? 0)
  const foodCost   = Number(td?.food_cost  ?? mm?.food_cost  ?? 0)
  const staffCost  = Number(mm?.staff_cost ?? td?.staff_cost ?? 0)
  const otherCost  = Number(td?.other_cost ?? mm?.other_cost ?? 0)
  const netProfit  = Number(td?.net_profit ?? mm?.net_profit ?? (revenue - foodCost - staffCost - otherCost))
  const marginPct  = revenue > 0 ? (netProfit / revenue) * 100 : 0

  const categoryLabel = (c: string) =>
      c === 'revenue'     ? 'Revenue'
    : c === 'food_cost'   ? 'Food cost'
    : c === 'staff_cost'  ? 'Staff cost'
    : c === 'other_cost'  ? 'Other operating costs'
    : c === 'depreciation'? 'Depreciation'
    : c === 'financial'   ? 'Financial items'
    : c

  const generated = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Accountant summary — ${esc(biz.name)} · ${MONTHS[month - 1]} ${year}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; margin: 0; padding: 30px; max-width: 800px; }
    h1 { margin: 0 0 6px; font-size: 22px; font-weight: 500; }
    .meta { color: #6b7280; font-size: 12px; margin-bottom: 24px; }
    h2 { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin: 24px 0 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 6px 10px; border-bottom: 1px solid #f3f4f6; text-align: left; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #9ca3af; background: #f9fafb; font-weight: 500; }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .rollup td { padding: 8px 12px; font-size: 14px; }
    .rollup .label { color: #374151; }
    .rollup .value { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
    .rollup .net    { border-top: 2px solid #111; font-weight: 700; }
    .rollup .margin { color: ${netProfit >= 0 ? '#15803d' : '#b91c1c'}; }
    .category { background: #f9fafb; font-weight: 600; }
    .footer { margin-top: 32px; font-size: 11px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 14px; line-height: 1.6; }
    .print-btn { position: fixed; top: 20px; right: 20px; padding: 8px 14px; background: #1a1f2e; color: white; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; }
    @media print { .print-btn { display: none; } body { padding: 20px; } }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Print / save PDF</button>

  <h1>${esc(biz.name)}${biz.city ? ' · ' + esc(biz.city) : ''}</h1>
  <div class="meta">Management P&amp;L · ${MONTHS[month - 1]} ${year} · Generated ${esc(generated)}</div>

  <h2>Rollup</h2>
  <table class="rollup">
    <tr><td class="label">Revenue</td>                  <td class="value">${kr(revenue)}</td></tr>
    <tr><td class="label">− Food cost</td>              <td class="value">${kr(foodCost)}</td></tr>
    <tr><td class="label">− Staff cost</td>             <td class="value">${kr(staffCost)}</td></tr>
    <tr><td class="label">− Other operating costs</td>  <td class="value">${kr(otherCost)}</td></tr>
    <tr class="net"><td class="label">Net profit</td>   <td class="value margin">${kr(netProfit)} (${pct(marginPct)})</td></tr>
  </table>

  ${Object.keys(byCat).length === 0 ? `
    <h2>Line items</h2>
    <p style="font-size: 13px; color: #6b7280;">No line-item detail available for this period.</p>
  ` : `
    <h2>Line items</h2>
    <table>
      <thead>
        <tr>
          <th>Label</th>
          <th>Category</th>
          <th>Account</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(byCat).map(([cat, rows]) => `
          <tr class="category"><td colspan="4">${esc(categoryLabel(cat))} (${rows.length} line${rows.length === 1 ? '' : 's'})</td></tr>
          ${rows.map(r => `
            <tr>
              <td>${esc(r.label_sv)}</td>
              <td style="color: #6b7280;">${esc(r.subcategory ?? '—')}</td>
              <td style="color: #9ca3af; font-variant-numeric: tabular-nums;">${esc(r.fortnox_account ?? '—')}</td>
              <td class="num">${kr(Number(r.amount))}</td>
            </tr>
          `).join('')}
        `).join('')}
      </tbody>
    </table>
  `}

  <div class="footer">
    Management view — not a regulated financial statement.<br>
    Revenue from POS + Personalkollen syncs. Costs from Fortnox PDFs applied via CommandCenter.<br>
    Business-wide figures, not split by department.<br>
    Questions: reply to this email.
  </div>
</body>
</html>`

  return new NextResponse(html, {
    headers: {
      'Content-Type':     'text/html; charset=utf-8',
      'Cache-Control':    'no-store, max-age=0',
    },
  })
}

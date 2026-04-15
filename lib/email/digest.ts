// lib/email/digest.ts
// Generates the Monday morning digest email HTML

export interface DigestData {
  orgName:        string
  weekLabel:      string
  businesses:     BusinessDigest[]
  unsubscribeUrl: string
}

export interface BusinessDigest {
  name:            string
  city:            string | null
  revenue:         number
  revenueLW:       number
  revenueBudget:   number | null
  foodPct:         number
  staffPct:        number
  foodBudgetPct:   number | null
  staffBudgetPct:  number | null
  covers:          number
  coversLW:        number
  revenuePerCover: number
  unpaidInvoices:  { vendor: string; amount: number; dueDate: string }[]
  topSuppliers:    { vendor: string; amount: number; category: string }[]
}

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-SE') + ' kr'
const fmtPct = (n: number) => n.toFixed(1) + '%'

function trendArrow(current: number, previous: number): string {
  if (!previous) return ''
  const pct = ((current - previous) / previous) * 100
  if (pct > 1)  return `<span style="color:#16a34a">▲ ${pct.toFixed(1)}%</span>`
  if (pct < -1) return `<span style="color:#dc2626">▼ ${Math.abs(pct).toFixed(1)}%</span>`
  return `<span style="color:#9ca3af">→ flat</span>`
}

function statusDot(actual: number, budget: number | null, higherIsBetter = true): string {
  if (!budget) return ''
  const good = higherIsBetter ? actual >= budget * 0.95 : actual <= budget * 1.05
  const warn = higherIsBetter ? actual >= budget * 0.85 : actual <= budget * 1.15
  const color = good ? '#16a34a' : warn ? '#d97706' : '#dc2626'
  return `<span style="color:${color}">●</span>`
}

function kpiCell(label: string, value: string, sub: string, badge = ''): string {
  return `<td style="width:25%;padding:0 8px 0 0;vertical-align:top">
    <div style="background:#f9fafb;border-radius:8px;padding:12px 14px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9ca3af;margin-bottom:5px">${label}</div>
      <div style="font-family:Georgia,serif;font-size:19px;font-weight:600;color:#111827;line-height:1.1">${value} ${badge}</div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${sub}</div>
    </div>
  </td>`
}

export function generateDigestHtml(data: DigestData): string {
  const sections = data.businesses.map(biz => {
    const unpaidRows = biz.unpaidInvoices.slice(0, 5).map(inv =>
      `<tr><td style="padding:7px 10px;font-size:12px;border-bottom:1px solid #fef2f2">${inv.vendor}</td>
       <td style="padding:7px 10px;font-size:12px;font-weight:600;color:#dc2626;text-align:right;border-bottom:1px solid #fef2f2">${fmtKr(inv.amount)}</td>
       <td style="padding:7px 10px;font-size:12px;color:#9ca3af;text-align:right;border-bottom:1px solid #fef2f2">${inv.dueDate}</td></tr>`
    ).join('')

    const supplierRows = biz.topSuppliers.slice(0, 5).map(s =>
      `<tr><td style="padding:7px 10px;font-size:12px;border-bottom:1px solid #f3f4f6">${s.vendor}</td>
       <td style="padding:7px 10px;font-size:12px;font-weight:600;text-align:right;border-bottom:1px solid #f3f4f6">${fmtKr(s.amount)}</td>
       <td style="padding:7px 10px;font-size:12px;color:#6b7280;border-bottom:1px solid #f3f4f6">${s.category}</td></tr>`
    ).join('')

    const budgetPct = biz.revenueBudget && biz.revenueBudget > 0
      ? ((biz.revenue / biz.revenueBudget) * 100).toFixed(0) + '% of budget'
      : 'No budget set'

    return `
<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;margin-bottom:16px">
  <h2 style="font-family:Georgia,serif;font-size:17px;font-style:italic;color:#1e3a5f;margin:0 0 2px">${biz.name}</h2>
  <p style="font-size:12px;color:#9ca3af;margin:0 0 18px">${biz.city ?? ''}</p>

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px">
    <tr>
      ${kpiCell('Revenue', fmtKr(biz.revenue), trendArrow(biz.revenue, biz.revenueLW), statusDot(biz.revenue, biz.revenueBudget))}
      ${kpiCell('vs Budget', biz.revenueBudget ? fmtKr(biz.revenueBudget) : '—', budgetPct)}
      ${kpiCell('Food Cost', fmtPct(biz.foodPct), biz.foodBudgetPct ? `Budget: ${fmtPct(biz.foodBudgetPct)}` : 'No budget', statusDot(biz.foodPct, biz.foodBudgetPct, false))}
      ${kpiCell('Staff Cost', fmtPct(biz.staffPct), biz.staffBudgetPct ? `Budget: ${fmtPct(biz.staffBudgetPct)}` : 'No budget', statusDot(biz.staffPct, biz.staffBudgetPct, false))}
    </tr>
    <tr><td colspan="4" style="height:8px"></td></tr>
    <tr>
      ${kpiCell('Covers', biz.covers.toLocaleString(), trendArrow(biz.covers, biz.coversLW))}
      ${kpiCell('vs Last Week', biz.coversLW.toLocaleString(), 'previous week')}
      ${kpiCell('Rev / Cover', fmtKr(biz.revenuePerCover), 'Revenue per cover')}
      <td style="width:25%"></td>
    </tr>
  </table>

  ${biz.unpaidInvoices.length > 0 ? `
  <div style="margin-top:16px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#dc2626;margin-bottom:8px">⚠ Outstanding Invoices (${biz.unpaidInvoices.length})</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #fecaca;border-radius:8px;overflow:hidden">
      <tr style="background:#fef2f2">
        <th style="padding:7px 10px;text-align:left;font-size:11px;color:#9ca3af;font-weight:600">Vendor</th>
        <th style="padding:7px 10px;text-align:right;font-size:11px;color:#9ca3af;font-weight:600">Amount</th>
        <th style="padding:7px 10px;text-align:right;font-size:11px;color:#9ca3af;font-weight:600">Due date</th>
      </tr>
      ${unpaidRows}
    </table>
  </div>` : ''}

  ${biz.topSuppliers.length > 0 ? `
  <div style="margin-top:14px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:8px">Top Supplier Invoices This Week</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <tr style="background:#f9fafb">
        <th style="padding:7px 10px;text-align:left;font-size:11px;color:#9ca3af;font-weight:600">Vendor</th>
        <th style="padding:7px 10px;text-align:right;font-size:11px;color:#9ca3af;font-weight:600">Amount</th>
        <th style="padding:7px 10px;text-align:left;font-size:11px;color:#9ca3af;font-weight:600">Category</th>
      </tr>
      ${supplierRows}
    </table>
  </div>` : ''}
</div>`
  }).join('')

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weekly Digest</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px 12px">

  <div style="text-align:center;padding:28px 0 20px">
    <div style="display:inline-block;background:#1e3a5f;color:white;font-weight:800;font-size:14px;letter-spacing:.05em;border-radius:8px;padding:6px 14px;margin-bottom:14px">CommandCenter</div>
    <h1 style="font-family:Georgia,serif;font-size:24px;font-style:italic;color:#1e3a5f;margin:0 0 6px">Good morning ☕</h1>
    <p style="font-size:13px;color:#6b7280;margin:0">${data.weekLabel} &middot; ${data.orgName}</p>
  </div>

  ${sections}

  <div style="text-align:center;padding:20px 0;border-top:1px solid #e5e7eb;margin-top:8px">
    <p style="font-size:11px;color:#9ca3af;margin:0 0 4px">CommandCenter &mdash; Restaurant Intelligence Platform</p>
    <p style="font-size:11px;margin:0"><a href="${data.unsubscribeUrl}" style="color:#9ca3af;text-decoration:underline">Unsubscribe from weekly digest</a></p>
  </div>
</div>
</body></html>`
}

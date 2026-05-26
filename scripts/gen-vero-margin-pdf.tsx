// Generate the REAL Vero margin PDF from production data + AI, locally.
// Run: npx tsx scripts/gen-vero-margin-pdf.tsx
// (Replicates lib/reports/margin-report.ts inline to avoid @/ alias issues
//  in tsx; the deployed endpoint uses the real shared module.)
import { writeFileSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { renderMarginPdf } from '../components/reports/MarginReportPdf'

for (const line of readFileSync('.env.production.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const BIZ = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const MN = ['', 'Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const pct = (p: number, w: number) => w > 0 ? Math.round((p / w) * 1000) / 10 : 0

;(async () => {
  const { data } = await db.from('tracker_data')
    .select('period_year, period_month, revenue, food_cost, staff_cost, other_cost, net_profit, margin_pct')
    .eq('business_id', BIZ).or('is_provisional.is.null,is_provisional.eq.false')
    .order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(12)

  const months = (data ?? []).map((r: any) => {
    const revenue = Number(r.revenue ?? 0), food = Number(r.food_cost ?? 0), staff = Number(r.staff_cost ?? 0)
    return { year: +r.period_year, month: +r.period_month, label: `${MN[+r.period_month]} ${r.period_year}`,
      revenue, food_cost: food, staff_cost: staff, other_cost: Number(r.other_cost ?? 0),
      net_profit: Number(r.net_profit ?? 0), margin_pct: Number(r.margin_pct ?? 0),
      food_pct: pct(food, revenue), labour_pct: pct(staff, revenue) }
  }).filter((m: any) => m.revenue > 0).sort((a: any, b: any) => a.year - b.year || a.month - b.month)

  const isAnom = (m: any) => (m.labour_pct === 0 && m.revenue > 0) || m.food_pct > 80 || m.margin_pct < -150
  months.forEach((m: any) => { m.is_anomaly = isAnom(m) })
  const clean = months.filter((m: any) => m.revenue > 0 && !m.is_anomaly)
  const base = clean.length ? clean : months.filter((m: any) => m.revenue > 0)
  const anomaly_count = months.filter((m: any) => m.is_anomaly).length
  const avg = (f: (m: any) => number) => base.length ? Math.round((base.reduce((s, m) => s + f(m), 0) / base.length) * 10) / 10 : 0
  const averages = { margin_pct: avg(m => m.margin_pct), food_pct: avg(m => m.food_pct), labour_pct: avg(m => m.labour_pct),
    revenue: base.length ? Math.round(base.reduce((s, m) => s + m.revenue, 0) / base.length) : 0 }
  console.log(`Anomaly months excluded from averages: ${anomaly_count}`)

  // AI narrative (direct call, prod key)
  let summary = '', recs: any[] = [], aiUsed = false
  const table = months.map(m => `${m.label}: revenue ${Math.round(m.revenue)} kr, food ${m.food_pct}%, labour ${m.labour_pct}%, net margin ${m.margin_pct}%`).join('\n')
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2200,
        system: 'You are a restaurant-group CFO advisor. Ground every claim in the figures. For labour only recommend reducing/optimising hours. Food target 28-32%, healthy net margin ~10-15%. Return JSON only: {"executive_summary":"2-3 sentences","recommendations":[{"title":"","detail":""}]}',
        messages: [{ role: 'user', content: `Vero Italiano. Averages: margin ${averages.margin_pct}%, food ${averages.food_pct}%, labour ${averages.labour_pct}%.\n${table}\nJSON only.` }] }) })
    const j: any = await res.json()
    const t = j?.content?.[0]?.text ?? ''
    const p = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1))
    summary = p.executive_summary; recs = (p.recommendations ?? []).map((r: any) => ({ title: String(r.title), detail: String(r.detail ?? '') })); aiUsed = true
  } catch (e: any) { console.log('AI failed (will use fallback):', e?.message) }

  const spec = { business_name: 'Vero Italiano', period_label: months.length ? `${months[0].label} – ${months[months.length-1].label}` : '—',
    generated_at: new Date().toISOString(), months, latest: months[months.length-1] ?? null, averages, anomaly_count,
    executive_summary: summary || `Averaged ${averages.margin_pct}% net margin.`, recommendations: recs, ai_used: aiUsed }

  const buf = await renderMarginPdf(spec as any)
  writeFileSync('scripts/_vero-margin.pdf', buf)
  console.log(`\n=== Vero margin PDF: ${buf.length} bytes, ${buf.subarray(0,5).toString('latin1') === '%PDF-' ? 'VALID' : 'INVALID'} ===`)
  console.log(`Months: ${months.length} | Avg margin ${averages.margin_pct}% · food ${averages.food_pct}% · labour ${averages.labour_pct}% · rev ${averages.revenue.toLocaleString('en-GB')} kr`)
  console.log('\nExecutive summary:\n' + spec.executive_summary)
  console.log('\nRecommendations:')
  recs.forEach((r, i) => console.log(`  ${i+1}. ${r.title} — ${r.detail}`))
})()

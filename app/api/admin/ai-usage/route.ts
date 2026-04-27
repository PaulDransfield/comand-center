// @ts-nocheck
// app/api/admin/ai-usage/route.ts
//
// Admin-only AI usage + cost visibility.
//
//   GET /api/admin/ai-usage                → global rollup
//   GET /api/admin/ai-usage?org_id=<uuid>  → single-org detail
//
// Returns daily totals, per-user breakdown, active AI Boosters, last 20
// questions (redacted previews only). Every cost in SEK + USD.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret }          from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function ymd(d: Date): string { return d.toISOString().slice(0, 10) }

export async function GET(req: NextRequest) {
  if (!checkAdminSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db    = createAdminClient()
  const orgId = req.nextUrl.searchParams.get('org_id')
  const today = new Date()
  const monthStart = ymd(new Date(today.getFullYear(), today.getMonth(), 1))
  const weekStart  = ymd(new Date(today.getTime() - 6 * 86400000))
  const todayStr   = ymd(today)

  // ── SINGLE ORG DETAIL ───────────────────────────────────────────────────────
  if (orgId) {
    const [dailyRes, recentRes, boostersRes, byUserRes] = await Promise.all([
      // Daily rollup for the last 31 days
      db.from('ai_request_log')
        .select('created_at, cost_usd, cost_sek, input_tokens, output_tokens, model, tier, request_type')
        .eq('org_id', orgId)
        .gte('created_at', monthStart)
        .order('created_at', { ascending: false }),

      // Last 20 questions (question_preview is first 100 chars only)
      db.from('ai_request_log')
        .select('created_at, request_type, model, tier, page, question_preview, cost_sek, input_tokens, output_tokens, user_id')
        .eq('org_id', orgId)
        .not('request_type', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20),

      // Active Boosters
      db.from('ai_booster_purchases')
        .select('*')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .gte('period_end', todayStr)
        .order('period_end', { ascending: false }),

      // Per-user breakdown for the current month
      db.from('ai_usage_daily_by_user')
        .select('user_id, query_count, cost_usd, cost_sek, date')
        .eq('org_id', orgId)
        .gte('date', monthStart),
    ])

    const rows = dailyRes.data ?? []

    // Aggregate today, week, month totals
    const today_total = rows.filter((r: any) => r.created_at.slice(0, 10) === todayStr)
    const week_total  = rows.filter((r: any) => r.created_at.slice(0, 10) >= weekStart)

    const agg = (arr: any[]) => ({
      queries:    arr.length,
      input_tok:  arr.reduce((s: number, r: any) => s + Number(r.input_tokens  ?? 0), 0),
      output_tok: arr.reduce((s: number, r: any) => s + Number(r.output_tokens ?? 0), 0),
      cost_usd:   Math.round(arr.reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0) * 10000) / 10000,
      cost_sek:   Math.round(arr.reduce((s: number, r: any) => s + Number(r.cost_sek       ?? 0), 0) * 100) / 100,
    })

    // Model / tier mix for the month
    const mix: Record<string, number> = {}
    for (const r of rows) {
      const k = `${r.model ?? 'unknown'}|${r.tier ?? '-'}`
      mix[k] = (mix[k] ?? 0) + 1
    }

    // Per-user aggregation
    const byUser: Record<string, { queries: number; cost_sek: number; cost_usd: number }> = {}
    for (const r of byUserRes.data ?? []) {
      const key = r.user_id ?? 'unknown'
      if (!byUser[key]) byUser[key] = { queries: 0, cost_sek: 0, cost_usd: 0 }
      byUser[key].queries  += Number(r.query_count ?? 0)
      byUser[key].cost_sek += Number(r.cost_sek    ?? 0)
      byUser[key].cost_usd += Number(r.cost_usd    ?? 0)
    }
    // Enrich with emails
    const userIds = Object.keys(byUser).filter(uid => uid !== 'unknown')
    const users: any[] = []
    for (const uid of userIds) {
      try {
        const { data: { user } } = await db.auth.admin.getUserById(uid)
        if (user?.email) users.push({ user_id: uid, email: user.email, ...byUser[uid] })
      } catch { /* ignore */ }
    }
    users.sort((a, b) => b.queries - a.queries)

    return NextResponse.json({
      today:     agg(today_total),
      week:      agg(week_total),
      month:     agg(rows),
      model_mix: Object.entries(mix).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
      by_user:   users,
      boosters:  boostersRes.data ?? [],
      recent:    recentRes.data ?? [],
    })
  }

  // ── GLOBAL ROLLUP ───────────────────────────────────────────────────────────
  const [monthRes, orgsRes, boostersRes] = await Promise.all([
    db.from('ai_request_log')
      .select('org_id, cost_usd, cost_sek, input_tokens, output_tokens, model, tier, created_at')
      .gte('created_at', monthStart),
    db.from('organisations').select('id, name, plan'),
    db.from('ai_booster_purchases')
      .select('org_id, amount_sek, period_start, period_end, status')
      .eq('status', 'active')
      .gte('period_end', todayStr),
  ])

  const rows    = monthRes.data ?? []
  const orgMap  = new Map((orgsRes.data ?? []).map((o: any) => [o.id, o]))

  const today_total = rows.filter((r: any) => r.created_at.slice(0, 10) === todayStr)
  const week_total  = rows.filter((r: any) => r.created_at.slice(0, 10) >= weekStart)

  const sum = (arr: any[]) => ({
    queries:  arr.length,
    cost_usd: Math.round(arr.reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0) * 10000) / 10000,
    cost_sek: Math.round(arr.reduce((s: number, r: any) => s + Number(r.cost_sek       ?? 0), 0) * 100) / 100,
  })

  // Top spenders this month
  const byOrg: Record<string, any> = {}
  for (const r of rows) {
    const k = r.org_id ?? 'unknown'
    if (!byOrg[k]) byOrg[k] = { org_id: k, org_name: (orgMap.get(k) as any)?.name ?? k.slice(0, 8), plan: (orgMap.get(k) as any)?.plan ?? 'unknown', queries: 0, cost_usd: 0, cost_sek: 0 }
    byOrg[k].queries  += 1
    byOrg[k].cost_usd += Number(r.cost_usd ?? 0)
    byOrg[k].cost_sek += Number(r.cost_sek       ?? 0)
  }
  const topSpenders = Object.values(byOrg)
    .sort((a: any, b: any) => b.cost_sek - a.cost_sek)
    .slice(0, 20)
    .map((o: any) => ({ ...o, cost_usd: Math.round(o.cost_usd * 10000) / 10000, cost_sek: Math.round(o.cost_sek * 100) / 100 }))

  const mix: Record<string, number> = {}
  for (const r of rows) {
    const k = `${r.model ?? 'unknown'}|${r.tier ?? '-'}`
    mix[k] = (mix[k] ?? 0) + 1
  }

  return NextResponse.json({
    today:        sum(today_total),
    week:         sum(week_total),
    month:        sum(rows),
    model_mix:    Object.entries(mix).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count),
    top_spenders: topSpenders,
    active_boosters: boostersRes.data ?? [],
    booster_revenue_sek: (boostersRes.data ?? []).reduce((s: number, b: any) => s + Number(b.amount_sek ?? 0), 0),
  })
}

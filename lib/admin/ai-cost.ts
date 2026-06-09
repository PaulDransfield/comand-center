// lib/admin/ai-cost.ts
//
// A3.4 — AI cost dashboard engine. Aggregates ai_request_log into the
// summary shapes the /admin/ai-cost page consumes.
//
// We pull cost_usd off the rows directly (logAiRequest writes it at
// insert time via calcCostUsd), so the aggregator is pure arithmetic.
//
// Read-only. Service-role only (admin surface bypasses RLS).

import type { SupabaseClient } from '@supabase/supabase-js'

export interface AiCostRow {
  org_id:        string
  user_id:       string | null
  request_type:  string
  model:         string
  tier:          string | null
  page:          string | null
  input_tokens:  number
  output_tokens: number
  cost_usd:      number
  cost_sek:      number
  duration_ms:   number | null
  created_at:    string
}

export interface AggregateBucket {
  count:         number
  input_tokens:  number
  output_tokens: number
  cost_usd:      number
  cost_sek:      number
}

export interface AiCostSummary {
  window_from:        string
  window_to:          string
  computed_at:        string
  total: {
    requests:         number
    cost_usd:         number
    cost_sek:         number
    input_tokens:     number
    output_tokens:    number
  }
  today_usd:          number
  mtd_usd:            number
  max_daily_usd:      number
  pct_of_cap:         number       // today_usd / max_daily_usd × 100
  alert_level:        'ok' | 'warning' | 'critical'  // ≥70% warning, ≥90% critical
  by_day:             Array<{ date: string; requests: number; cost_usd: number; cost_sek: number }>
  by_org:             Array<{ org_id: string; org_name: string | null } & AggregateBucket>
  by_surface:         Array<{ key: string } & AggregateBucket>       // request_type
  by_model:           Array<{ key: string } & AggregateBucket>
  by_page:            Array<{ key: string } & AggregateBucket>
}

const TARGET_WINDOW_DAYS = 30

export async function computeAiCostSummary(
  db:           SupabaseClient,
  windowDays:   number = TARGET_WINDOW_DAYS,
): Promise<AiCostSummary> {
  const maxDailyUsd = Number(process.env.MAX_DAILY_GLOBAL_USD ?? '150')
  const now         = new Date()
  const windowFrom  = new Date(now.getTime() - windowDays * 86_400_000)
  const fromIso     = windowFrom.toISOString()
  const toIso       = now.toISOString()
  const todayIso    = now.toISOString().slice(0, 10)
  const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)

  // Pull rows in pages — at ~150 USD / day × 30 days the row count is
  // bounded but we paginate defensively.
  const rows: AiCostRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('ai_request_log')
      .select('org_id, user_id, request_type, model, tier, page, input_tokens, output_tokens, cost_usd, cost_sek, duration_ms, created_at')
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
      .order('created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`ai_request_log read: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...(data as any))
    if (data.length < 1000) break
    if (rows.length > 50_000) break  // safety
  }

  // Build org_id → name map (single query)
  const orgIds = Array.from(new Set(rows.map(r => r.org_id))).filter(Boolean)
  const orgNameById = new Map<string, string | null>()
  if (orgIds.length > 0) {
    const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgNameById.set((o as any).id, (o as any).name ?? null)
  }

  // Totals + today/mtd
  let totalRequests = 0, totalInput = 0, totalOutput = 0, totalUsd = 0, totalSek = 0
  let todayUsd = 0, mtdUsd = 0
  const byDay: Record<string, { requests: number; cost_usd: number; cost_sek: number }> = {}
  const agg = <K extends string>(map: Record<K, AggregateBucket>, key: K, r: AiCostRow) => {
    if (!map[key]) map[key] = { count: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_sek: 0 }
    const b = map[key]
    b.count++
    b.input_tokens  += Number(r.input_tokens  ?? 0)
    b.output_tokens += Number(r.output_tokens ?? 0)
    b.cost_usd      += Number(r.cost_usd      ?? 0)
    b.cost_sek      += Number(r.cost_sek      ?? 0)
  }
  const byOrg:     Record<string, AggregateBucket> = {}
  const bySurface: Record<string, AggregateBucket> = {}
  const byModel:   Record<string, AggregateBucket> = {}
  const byPage:    Record<string, AggregateBucket> = {}

  for (const r of rows) {
    const usd = Number(r.cost_usd ?? 0)
    const sek = Number(r.cost_sek ?? 0)
    totalRequests++
    totalInput  += Number(r.input_tokens  ?? 0)
    totalOutput += Number(r.output_tokens ?? 0)
    totalUsd    += usd
    totalSek    += sek
    const dateStr = String(r.created_at).slice(0, 10)
    if (dateStr === todayIso) todayUsd += usd
    if (dateStr >= monthStart) mtdUsd  += usd
    if (!byDay[dateStr]) byDay[dateStr] = { requests: 0, cost_usd: 0, cost_sek: 0 }
    byDay[dateStr].requests++
    byDay[dateStr].cost_usd += usd
    byDay[dateStr].cost_sek += sek

    agg(byOrg,     r.org_id ?? 'unknown', r)
    agg(bySurface, r.request_type ?? 'unknown', r)
    agg(byModel,   r.model ?? 'unknown', r)
    agg(byPage,    r.page ?? '(none)',    r)
  }

  // Sort + format outputs
  const round2 = (n: number) => Math.round(n * 100) / 100
  const round4 = (n: number) => Math.round(n * 10000) / 10000

  const finaliseBucket = (b: AggregateBucket): AggregateBucket => ({
    count:         b.count,
    input_tokens:  b.input_tokens,
    output_tokens: b.output_tokens,
    cost_usd:      round4(b.cost_usd),
    cost_sek:      round2(b.cost_sek),
  })

  const sortedDays = Object.entries(byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, requests: v.requests, cost_usd: round4(v.cost_usd), cost_sek: round2(v.cost_sek) }))

  const sortedOrgs = Object.entries(byOrg)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([org_id, b]) => ({ org_id, org_name: orgNameById.get(org_id) ?? null, ...finaliseBucket(b) }))

  const sortedSurface = Object.entries(bySurface)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([key, b]) => ({ key, ...finaliseBucket(b) }))

  const sortedModel = Object.entries(byModel)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([key, b]) => ({ key, ...finaliseBucket(b) }))

  const sortedPage = Object.entries(byPage)
    .sort((a, b) => b[1].cost_usd - a[1].cost_usd)
    .map(([key, b]) => ({ key, ...finaliseBucket(b) }))

  const pctOfCap = maxDailyUsd > 0 ? (todayUsd / maxDailyUsd) * 100 : 0
  const alertLevel: 'ok' | 'warning' | 'critical' =
       pctOfCap >= 90 ? 'critical'
     : pctOfCap >= 70 ? 'warning'
     :                  'ok'

  return {
    window_from:    fromIso.slice(0, 10),
    window_to:      toIso.slice(0, 10),
    computed_at:    new Date().toISOString(),
    total: {
      requests:      totalRequests,
      cost_usd:      round4(totalUsd),
      cost_sek:      round2(totalSek),
      input_tokens:  totalInput,
      output_tokens: totalOutput,
    },
    today_usd:      round4(todayUsd),
    mtd_usd:        round4(mtdUsd),
    max_daily_usd:  maxDailyUsd,
    pct_of_cap:     round2(pctOfCap),
    alert_level:    alertLevel,
    by_day:         sortedDays,
    by_org:         sortedOrgs,
    by_surface:     sortedSurface,
    by_model:       sortedModel,
    by_page:        sortedPage,
  }
}

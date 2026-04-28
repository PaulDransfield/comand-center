// app/api/admin/v2/incidents/route.ts
//
// Returns the list of "things that need Paul's attention right now" for
// the new admin overview page. READ-ONLY — no recordAdminAction needed.
//
// Three categories shipping in PR 2:
//   1. stuck_integration   — integrations with status='error' OR
//                            'needs_reauth' for active orgs
//   2. data_stale          — orgs with an active connected integration but
//                            no daily_metrics row in the last 48h
//   3. ai_cost_outlier     — orgs whose 24h AI cost > 5× their 7-day median
//
// Deferred (note in code, not shipped this PR per the plan):
//   - token_expiring  → no explicit "expires in 7d" signal in our schema;
//     covered indirectly by stuck_integration (needs_reauth fires when
//     PK / Fortnox returns 401)
//   - stripe_webhook_backlog → the two-phase dedup pattern the plan
//     references hasn't shipped yet; the current pattern is single-phase
//     so there's no "stuck row" to detect
//   - pending_migration → reading MIGRATIONS.md from disk in an API
//     route is fiddly; defer to a follow-up that does it via a build-time
//     constant or a tiny pg view of `pg_extension`/manual marker table
//
// Auth: requireAdmin. Returns 401 on missing secret.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { createAdminClient } from '@/lib/supabase/server'
import type { Incident } from '@/lib/admin/v2/types'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()
  const now    = Date.now()
  const day1   = new Date(now -  1 * 86400_000).toISOString()
  const day2   = new Date(now -  2 * 86400_000).toISOString().slice(0, 10)
  const day7   = new Date(now -  7 * 86400_000).toISOString().slice(0, 10)
  const today  =                                  new Date(now).toISOString().slice(0, 10)
  const yday   = new Date(now -  1 * 86400_000).toISOString().slice(0, 10)

  const incidents: Incident[] = []

  // ── Active orgs (used by every detector) ─────────────────────────────────
  const { data: orgs } = await db
    .from('organisations')
    .select('id, name, plan, is_active')
    .eq('is_active', true)
  const activeOrgIds = new Set((orgs ?? []).map((o: any) => o.id))
  const orgById = new Map((orgs ?? []).map((o: any) => [o.id, o]))

  // ── 1. Stuck integrations ────────────────────────────────────────────────
  // status = 'error' OR 'needs_reauth' on any active org's integration.
  // A connected integration that hasn't synced in >24h on an active org
  // also counts (silent failure — sync engine isn't writing the error
  // status correctly, or the cron isn't firing).
  try {
    const { data: stuck } = await db
      .from('integrations')
      .select('id, org_id, business_id, provider, status, last_sync_at')
      .in('status', ['error', 'needs_reauth'])
    for (const r of stuck ?? []) {
      if (!activeOrgIds.has(r.org_id)) continue   // skip churned/inactive orgs
      const org = orgById.get(r.org_id) as any
      const sevMap: Record<string, Incident['severity']> = {
        error:        'critical',
        needs_reauth: 'warn',
      }
      incidents.push({
        kind:        'stuck_integration',
        severity:    sevMap[r.status] ?? 'warn',
        org_id:      r.org_id,
        org_name:    org?.name ?? r.org_id.slice(0, 8),
        title:       `${r.provider} ${r.status === 'error' ? 'errored' : 'needs re-auth'}`,
        detail:      r.last_sync_at
          ? `Last sync ${niceAgo(new Date(r.last_sync_at).getTime(), now)}`
          : 'Never synced',
        href:        `/admin/customers/${r.org_id}`,   // PR 4 will swap this to /admin/v2/customers/...
        detected_at: r.last_sync_at ?? new Date().toISOString(),
      })
    }

    // Connected but silent for >24h.
    const { data: silent } = await db
      .from('integrations')
      .select('id, org_id, business_id, provider, status, last_sync_at')
      .eq('status', 'connected')
      .lt('last_sync_at', day1)
    for (const r of silent ?? []) {
      if (!activeOrgIds.has(r.org_id)) continue
      const org = orgById.get(r.org_id) as any
      incidents.push({
        kind:        'stuck_integration',
        severity:    'warn',
        org_id:      r.org_id,
        org_name:    org?.name ?? r.org_id.slice(0, 8),
        title:       `${r.provider} silent`,
        detail:      `No sync in ${niceAgo(new Date(r.last_sync_at).getTime(), now)} despite connected status`,
        href:        `/admin/customers/${r.org_id}`,
        detected_at: r.last_sync_at,
      })
    }
  } catch (e: any) {
    console.warn('[incidents] stuck_integration probe failed:', e?.message)
  }

  // ── 2. Stale data ────────────────────────────────────────────────────────
  // Org has at least one connected integration but no daily_metrics row
  // in the last 48h. Means sync ran but aggregator didn't write — or the
  // venue is genuinely closed (rare for 48h+ on a restaurant).
  try {
    const { data: connectedRows } = await db
      .from('integrations')
      .select('org_id')
      .eq('status', 'connected')
    const orgsWithConnected = new Set((connectedRows ?? []).map((r: any) => r.org_id))
    const { data: recentMetrics } = await db
      .from('daily_metrics')
      .select('org_id, date')
      .gte('date', day2)
    const orgsWithRecentData = new Set((recentMetrics ?? []).map((r: any) => r.org_id))
    for (const orgId of orgsWithConnected) {
      if (!activeOrgIds.has(orgId))    continue
      if (orgsWithRecentData.has(orgId)) continue
      const org = orgById.get(orgId) as any
      incidents.push({
        kind:        'data_stale',
        severity:    'warn',
        org_id:      orgId as string,
        org_name:    org?.name ?? (orgId as string).slice(0, 8),
        title:       `No daily_metrics in 48h`,
        detail:      `Active integrations but no aggregated rows since ${day2}`,
        href:        `/admin/customers/${orgId}`,
        detected_at: new Date().toISOString(),
      })
    }
  } catch (e: any) {
    console.warn('[incidents] data_stale probe failed:', e?.message)
  }

  // ── 3. AI cost outliers ──────────────────────────────────────────────────
  // Per org: today's cost_sek vs the org's 7-day median (excluding today).
  // Flag when today > 5× median AND today > 5 SEK (avoid false positives
  // on tiny baselines).
  try {
    const { data: rows } = await db
      .from('ai_request_log')
      .select('org_id, cost_sek, created_at')
      .gte('created_at', day7 + 'T00:00:00')
      .order('created_at', { ascending: false })
      .limit(20000)
    // Group cost per org per day.
    const byOrg: Record<string, Record<string, number>> = {}
    for (const r of rows ?? []) {
      const oid = r.org_id ?? ''
      const day = (r.created_at ?? '').slice(0, 10)
      if (!byOrg[oid]) byOrg[oid] = {}
      byOrg[oid][day] = (byOrg[oid][day] ?? 0) + Number(r.cost_sek ?? 0)
    }
    for (const [oid, days] of Object.entries(byOrg)) {
      if (!activeOrgIds.has(oid)) continue
      const todayCost = days[today] ?? days[yday] ?? 0
      // Median of the prior 7 days excluding today.
      const priorDays = Object.entries(days)
        .filter(([d]) => d !== today)
        .map(([, v]) => v)
        .sort((a, b) => a - b)
      const median = priorDays.length ? priorDays[Math.floor(priorDays.length / 2)] : 0
      if (todayCost > 5 && median > 0 && todayCost > median * 5) {
        const org = orgById.get(oid) as any
        incidents.push({
          kind:        'ai_cost_outlier',
          severity:    'warn',
          org_id:      oid,
          org_name:    org?.name ?? oid.slice(0, 8),
          title:       `AI cost ${(todayCost / median).toFixed(1)}× their median`,
          detail:      `${Math.round(todayCost)} kr today vs ${Math.round(median)} kr/day 7d median`,
          href:        `/admin/customers/${oid}`,
          detected_at: new Date().toISOString(),
        })
      }
    }
  } catch (e: any) {
    console.warn('[incidents] ai_cost_outlier probe failed:', e?.message)
  }

  // ── Sort: critical first, then warn, then info; newest within tier ──────
  const sevOrder: Record<string, number> = { critical: 0, warn: 1, info: 2, ok: 3 }
  incidents.sort((a, b) => {
    const so = (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9)
    if (so !== 0) return so
    return (b.detected_at ?? '').localeCompare(a.detected_at ?? '')
  })

  return NextResponse.json(
    { incidents, generated_at: new Date().toISOString() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

// "5 minutes ago" / "3 hours ago" / "2 days ago"
function niceAgo(thenMs: number, nowMs: number): string {
  const ms = nowMs - thenMs
  if (ms < 0)              return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 1)               return 'just now'
  if (m < 60)              return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24)              return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

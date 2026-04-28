// app/api/admin/v2/customers/route.ts
//
// New customers list endpoint for /admin/v2/customers. Replaces the
// fixed-shape /api/admin/customers with one that accepts:
//
//   ?filter=needs_attention            (repeatable; multiple = AND)
//   ?filter=trial_ending
//   ?filter=high_ai
//   ?filter=no_login_30d
//   ?filter=active_subscription
//   ?search=<free text against name + owner email>
//   ?sort=name|plan|mrr|last_activity|created
//   ?order=asc|desc
//
// READ-ONLY. Auth: requireAdmin. Per the plan, push aggregation INTO SQL
// where possible — but most of these signals require multi-table joins
// against tables that don't have shared keys (auth.users for login,
// ai_usage_daily for AI %, etc.) so we still gather the inputs in
// parallel queries and compose in Node. The diff vs the old route is
// that filtering+sorting happens server-side in this route, not in the
// page component.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { getPlan }                   from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'

type FilterKey =
  | 'needs_attention'
  | 'trial_ending'
  | 'high_ai'
  | 'no_login_30d'
  | 'active_subscription'

type SortKey = 'name' | 'plan' | 'mrr' | 'last_activity' | 'created'
type Order   = 'asc' | 'desc'

const VALID_FILTERS: Record<FilterKey, true> = {
  needs_attention:     true,
  trial_ending:        true,
  high_ai:             true,
  no_login_30d:        true,
  active_subscription: true,
}
const VALID_SORTS: Record<SortKey, true> = {
  name: true, plan: true, mrr: true, last_activity: true, created: true,
}

const DAY_MS = 86_400_000

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  // ── Parse query params ───────────────────────────────────────────────
  const url     = new URL(req.url)
  const filters = new Set(
    url.searchParams.getAll('filter').filter((f): f is FilterKey => f in VALID_FILTERS),
  )
  const search  = (url.searchParams.get('search') ?? '').trim().toLowerCase()
  const sortRaw = (url.searchParams.get('sort') ?? 'last_activity') as SortKey
  const sort    = (sortRaw in VALID_SORTS ? sortRaw : 'last_activity') as SortKey
  const order   = (url.searchParams.get('order') === 'asc' ? 'asc' : 'desc') as Order

  const db        = createAdminClient()
  const now       = Date.now()
  const todayStr  = new Date().toISOString().slice(0, 10)
  const day7Str   = new Date(now + 7 * DAY_MS).toISOString().slice(0, 10)        // 7d in the future
  const day30Iso  = new Date(now - 30 * DAY_MS).toISOString()

  // ── Parallel data load ──────────────────────────────────────────────
  // Same set as /api/admin/customers but adds today's ai_usage_daily for
  // the high_ai filter. Auth users are fetched per-org below for emails.
  const [orgsRes, membersRes, integsRes, aiUsageRes] = await Promise.all([
    db.from('organisations')
      .select('id, name, plan, is_active, trial_end, created_at, stripe_customer_id')
      .order('created_at', { ascending: false }),
    db.from('organisation_members').select('org_id, user_id, role, created_at'),
    db.from('integrations').select('org_id, provider, status, last_sync_at, last_error'),
    db.from('ai_usage_daily').select('org_id, query_count').eq('date', todayStr),
  ])

  const orgs         = orgsRes.data         ?? []
  const members      = membersRes.data      ?? []
  const integrations = integsRes.data       ?? []
  const aiUsage      = aiUsageRes.data      ?? []

  // ── Owner email per org (first member's auth email) ─────────────────
  // The existing /api/admin/customers does this too. Cost: 1 admin
  // auth.getUserById per org. Acceptable at our scale (≤50 orgs).
  const firstMemberByOrg: Record<string, string> = {}
  for (const m of members) {
    if (!firstMemberByOrg[m.org_id]) firstMemberByOrg[m.org_id] = m.user_id
  }
  const lastSignInByUser: Record<string, string | null> = {}
  const emailByUser:      Record<string, string | null> = {}
  for (const uid of new Set(Object.values(firstMemberByOrg))) {
    try {
      const { data } = await db.auth.admin.getUserById(uid)
      emailByUser[uid]      = data?.user?.email             ?? null
      lastSignInByUser[uid] = data?.user?.last_sign_in_at   ?? null
    } catch {
      emailByUser[uid]      = null
      lastSignInByUser[uid] = null
    }
  }

  // ── Per-org enrichment + filter classification ───────────────────────
  const aiByOrg: Record<string, number> = {}
  for (const a of aiUsage) aiByOrg[a.org_id] = Number(a.query_count ?? 0)

  type Row = {
    id: string
    name: string
    plan: string
    is_active: boolean
    owner_email: string | null
    last_login_at: string | null
    trial_end: string | null
    created_at: string
    member_count: number
    integrations_total: number
    integrations_connected: number
    last_sync_at: string | null
    last_sync_days_ago: number | null
    has_integration_error: boolean
    ai_queries_today: number
    ai_daily_cap: number | null
    ai_pct_of_cap: number | null
    mrr_sek: number
    matches_filter: Record<FilterKey, boolean>
  }

  const rows: Row[] = orgs.map((o: any) => {
    const integs    = integrations.filter((i: any) => i.org_id === o.id)
    const connected = integs.filter((i: any) => i.status === 'connected')
    const errored   = integs.some((i: any) => i.status === 'error' || i.last_error)
    const lastSync  = integs.map((i: any) => i.last_sync_at ? new Date(i.last_sync_at).getTime() : 0).reduce((a, b) => Math.max(a, b), 0)
    const lastSyncDays = lastSync > 0 ? Math.floor((now - lastSync) / DAY_MS) : null
    const memberCount  = members.filter((m: any) => m.org_id === o.id).length
    const firstUserId  = firstMemberByOrg[o.id]
    const ownerEmail   = firstUserId ? emailByUser[firstUserId]      ?? null : null
    const lastLogin    = firstUserId ? lastSignInByUser[firstUserId] ?? null : null

    const aiToday = aiByOrg[o.id] ?? 0
    const plan    = getPlan(o.plan ?? 'trial')
    const dailyCap = plan.ai_queries_per_day === Infinity ? null : (plan.ai_queries_per_day || null)
    const aiPctOfCap = dailyCap && dailyCap > 0 ? Math.round((aiToday / dailyCap) * 100) : null
    const mrrSek = plan.price_sek ?? 0

    // Filter signals
    const isStuckIntegration = errored
                              || integs.some((i: any) => i.status === 'needs_reauth')
                              || (lastSyncDays !== null && lastSyncDays > 1 && connected.length > 0)
    const isStaleData        = false   // covered by stuck integration above; could split if useful
    const needsAttention     = o.is_active && (isStuckIntegration || isStaleData)
    const trialEnding        = o.plan === 'trial' && !!o.trial_end && o.trial_end <= day7Str && o.trial_end >= todayStr
    const highAi             = (aiPctOfCap ?? 0) > 50
    const noLogin30d         = !!lastLogin && lastLogin < day30Iso
    const activeSubscription = ['founding', 'solo', 'group', 'chain', 'starter', 'pro', 'enterprise'].includes(o.plan ?? '')

    return {
      id: o.id,
      name: o.name,
      plan: o.plan ?? 'trial',
      is_active: !!o.is_active,
      owner_email: ownerEmail,
      last_login_at: lastLogin,
      trial_end: o.trial_end,
      created_at: o.created_at,
      member_count: memberCount,
      integrations_total: integs.length,
      integrations_connected: connected.length,
      last_sync_at: lastSync > 0 ? new Date(lastSync).toISOString() : null,
      last_sync_days_ago: lastSyncDays,
      has_integration_error: errored,
      ai_queries_today: aiToday,
      ai_daily_cap: dailyCap,
      ai_pct_of_cap: aiPctOfCap,
      mrr_sek: mrrSek,
      matches_filter: {
        needs_attention:     needsAttention,
        trial_ending:        trialEnding,
        high_ai:             highAi,
        no_login_30d:        noLogin30d,
        active_subscription: activeSubscription,
      },
    }
  })

  // ── Apply filters (AND across selected chips) ────────────────────────
  let filtered = rows
  if (filters.size > 0) {
    filtered = filtered.filter(r => {
      for (const f of filters) {
        if (!r.matches_filter[f]) return false
      }
      return true
    })
  }

  // ── Free-text search (name + owner_email) ────────────────────────────
  if (search) {
    filtered = filtered.filter(r => {
      const hay = `${r.name ?? ''} ${r.owner_email ?? ''}`.toLowerCase()
      return hay.includes(search)
    })
  }

  // ── Sort ─────────────────────────────────────────────────────────────
  const dir = order === 'asc' ? 1 : -1
  filtered.sort((a, b) => {
    let av: any, bv: any
    switch (sort) {
      case 'name':          av = a.name?.toLowerCase() ?? ''; bv = b.name?.toLowerCase() ?? ''; break
      case 'plan':          av = a.plan; bv = b.plan; break
      case 'mrr':           av = a.mrr_sek; bv = b.mrr_sek; break
      case 'last_activity': av = a.last_sync_at ?? ''; bv = b.last_sync_at ?? ''; break
      case 'created':       av = a.created_at;        bv = b.created_at;        break
    }
    if (av < bv) return -1 * dir
    if (av > bv) return  1 * dir
    return 0
  })

  // ── Filter counts (so chips can show counts even when chip not active) ─
  const filterCounts: Record<FilterKey, number> = {
    needs_attention:     0,
    trial_ending:        0,
    high_ai:             0,
    no_login_30d:        0,
    active_subscription: 0,
  }
  for (const r of rows) {
    for (const f of Object.keys(VALID_FILTERS) as FilterKey[]) {
      if (r.matches_filter[f]) filterCounts[f]++
    }
  }

  return NextResponse.json({
    customers:    filtered,
    total:        filtered.length,
    grand_total:  rows.length,
    filter_counts: filterCounts,
    sort,
    order,
    applied_filters: [...filters],
    applied_search:  search,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

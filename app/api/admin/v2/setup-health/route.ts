// app/api/admin/v2/setup-health/route.ts
//
// Phase 3 — Admin rollup of customer setup health. Returns one row per
// Fortnox-connected business with the cached readiness summary, sorted
// by severity (fail > warn > pending > ok > unknown). Lets us spot
// customers whose setup degraded and proactively reach out.
//
// GET /api/admin/v2/setup-health
//   → { businesses: [{ business_id, business_name, org_id, org_name,
//                       overall, counts, failing_checks, evaluated_at,
//                       updated_minutes_ago, fortnox_status }] }
//
// Auth: ADMIN_SECRET as Bearer.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SEVERITY_RANK: Record<string, number> = {
  fail: 0, warn: 1, pending: 2, unknown: 3, ok: 4,
}

export async function GET(req: NextRequest) {
  noStore()

  const adminSecret = process.env.ADMIN_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (!adminSecret || auth !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()

  // Pull every Fortnox-connected business along with its cached health.
  // LEFT JOIN against integrations so we surface customers without any
  // Fortnox integration too (overall='unknown' — likely never connected).
  const { data: businesses, error } = await db
    .from('businesses')
    .select(`
      id, name, org_id,
      setup_health_summary, setup_health_updated_at,
      vat_filing_cadence,
      organisations ( id, name )
    `)
    .eq('is_active', true)
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Also pull Fortnox integration status per business in one round-trip.
  const { data: ints } = await db
    .from('integrations')
    .select('business_id, status, last_sync_at')
    .eq('provider', 'fortnox')

  const intByBiz = new Map<string, { status: string; last_sync_at: string | null }>()
  for (const i of (ints ?? [])) {
    if (i.business_id) intByBiz.set(i.business_id, { status: i.status, last_sync_at: i.last_sync_at })
  }

  const rows = (businesses ?? []).map((b: any) => {
    const s = b.setup_health_summary as any | null
    const overall = (s?.overall ?? 'unknown') as 'ok' | 'warn' | 'fail' | 'pending' | 'unknown'
    const fortnox = intByBiz.get(b.id) ?? null
    const updatedAt = b.setup_health_updated_at
    return {
      business_id:           b.id,
      business_name:         b.name,
      org_id:                b.org_id,
      org_name:              b.organisations?.name ?? null,
      vat_filing_cadence:    b.vat_filing_cadence ?? null,
      overall,
      counts:                s?.counts ?? null,
      failing_checks:        s?.failing_checks ?? [],
      evaluated_at:          updatedAt ?? null,
      updated_minutes_ago:   updatedAt ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60_000) : null,
      fortnox_status:        fortnox?.status ?? null,
      fortnox_last_sync_at:  fortnox?.last_sync_at ?? null,
    }
  })

  // Sort: severity first, then by oldest evaluation (most-stale issue surfaces).
  rows.sort((a, b) => {
    const sa = SEVERITY_RANK[a.overall] ?? 5
    const sb = SEVERITY_RANK[b.overall] ?? 5
    if (sa !== sb) return sa - sb
    const ta = a.evaluated_at ? new Date(a.evaluated_at).getTime() : 0
    const tb = b.evaluated_at ? new Date(b.evaluated_at).getTime() : 0
    return ta - tb
  })

  // Aggregate counts for the page header
  const summary = {
    total:      rows.length,
    ok:         rows.filter(r => r.overall === 'ok').length,
    warn:       rows.filter(r => r.overall === 'warn').length,
    fail:       rows.filter(r => r.overall === 'fail').length,
    pending:    rows.filter(r => r.overall === 'pending').length,
    unknown:    rows.filter(r => r.overall === 'unknown').length,
    no_fortnox: rows.filter(r => !r.fortnox_status).length,
  }

  return NextResponse.json({
    businesses: rows,
    summary,
    generated_at: new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

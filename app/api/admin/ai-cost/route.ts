// app/api/admin/ai-cost/route.ts
//
// A3.4 — admin AI cost surface. Aggregates ai_request_log over the
// requested window and returns the summary the /admin/ai-cost page
// consumes.
//
// GET /api/admin/ai-cost?days=30

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { createAdminClient } from '@/lib/supabase/server'
import { computeAiCostSummary } from '@/lib/admin/ai-cost'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TTL_MS = 60_000
let cached: { at: number; days: number; payload: any } | null = null

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if (!('ok' in guard)) return guard

  const u = new URL(req.url)
  const daysRaw = Number(u.searchParams.get('days') ?? '30')
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, Math.round(daysRaw))) : 30

  if (cached && cached.days === days && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  const db = createAdminClient()
  try {
    const summary = await computeAiCostSummary(db, days)
    cached = { at: Date.now(), days, payload: summary }
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'ai_cost_failed' }, { status: 500 })
  }
}

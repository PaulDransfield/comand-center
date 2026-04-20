// @ts-nocheck
// app/api/admin/memo-preview/route.ts
//
// Renders a past or fresh Monday memo as HTML so admins can see what the
// email looked like (and click through the thumbs-up / thumbs-down flow) on
// demand instead of waiting until Monday's cron fires.
//
// GET /api/admin/memo-preview?business_id=<uuid>[&week_start=YYYY-MM-DD]
//   ?secret=<ADMIN_SECRET> (or x-admin-secret header)
//
// Defaults to the most recent briefing for the business. If a week_start is
// given we fetch that specific briefing. Returns an HTML page with the email
// rendered inline — feedback buttons are live and will write to memo_feedback.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret }          from '@/lib/admin/check-secret'
import { memoEmailHtml }             from '@/lib/ai/weekly-manager'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id') ?? ''
  const weekStart  = u.searchParams.get('week_start')  // optional
  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  // Business + org lookup for the email header
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, org_id')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Find the briefing
  let q = db.from('briefings')
    .select('id, week_start, content, key_metrics, org_id, business_id')
    .eq('business_id', businessId)
    .order('week_start', { ascending: false })
    .limit(1)
  if (weekStart) q = q.eq('week_start', weekStart)
  const { data: briefings } = await q
  const briefing = briefings?.[0]
  if (!briefing) {
    return new Response(
      `<html><body style="font-family:sans-serif;padding:40px;max-width:520px;margin:0 auto;color:#374151">
         <h2>No briefing yet for ${biz.name}</h2>
         <p>Trigger the Monday briefing agent from <a href="/admin/agents">/admin/agents</a> — then reload this page.</p>
       </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }

  // Reconstruct the minimal ctx + memo shape that memoEmailHtml needs.
  const km        = briefing.key_metrics ?? {}
  const weekLabel = km.week ?? briefing.week_start
  const ctx: any  = {
    businessName: biz.name,
    weekLabel,
    thisWeek:     { revenue: km.revenue ?? 0, staff_cost: km.staff_cost ?? 0, labour_pct: km.labour_pct ?? null },
  }
  const memo: any = {
    narrative:   briefing.content ?? '',
    actions:     Array.isArray(km.actions)     ? km.actions     : [],
    facts_cited: Array.isArray(km.facts_cited) ? km.facts_cited : [],
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'

  const html = memoEmailHtml(ctx, memo, appUrl, biz.org_id, briefing.id)
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

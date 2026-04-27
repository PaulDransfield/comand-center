// @ts-nocheck
// app/api/admin/sync-history/route.ts
// One-time historical sync — pulls ALL Personalkollen data into staff_logs
// Call with: /api/admin/sync-history?secret=commandcenter_admin_2026&from=2024-01-01

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min timeout

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const from = req.nextUrl.searchParams.get('from') ?? '2024-01-01'
  const to   = req.nextUrl.searchParams.get('to')   ?? new Date().toISOString().slice(0,10)

  // Delegate to the cron route with the date range. CRON_SECRET must
  // be set in the environment — no fallback. Removed the hardcoded
  // 'commandcenter123' fallback (FIXES §0ee, Sprint 2 Task 8): if the
  // env var is missing the cron will fail auth, which is the correct
  // outcome for a misconfigured deploy.
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Server misconfigured: CRON_SECRET not set' }, { status: 500 })
  }
  const cronUrl = new URL('/api/cron/personalkollen-sync', req.url)
  cronUrl.searchParams.set('secret', process.env.CRON_SECRET)
  cronUrl.searchParams.set('from', from)
  cronUrl.searchParams.set('to', to)

  const res  = await fetch(cronUrl.toString())
  const data = await res.json()
  return NextResponse.json({ ok: true, from, to, ...data })
}

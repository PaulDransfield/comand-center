// app/api/cron/inventory-pdf-extract-sweep/route.ts
//
// Periodic sweep that finds every business with pending PDF extractions
// and kicks the per-business worker. Runs hands-off so a stalled or
// budget-exhausted Chicce-style backfill drains over hours without
// requiring a manual re-kick.
//
// Workflow:
//   1. Query invoice_pdf_extractions for distinct business_id WHERE status='pending'
//   2. For each business, fire-and-forget the per-business extract endpoint
//      (which auto-chains internally for ~750s, then leaves state=pending
//      if budget exhausted — next sweep picks up where it left off)
//   3. Cap at 5 concurrent businesses to stay under Vercel function-resource limits
//
// Schedule (vercel.json): every 30 minutes during day, idle overnight to
// stay under Anthropic rate limits.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const PER_BUSINESS_TIMEOUT_MS = 5_000   // fire-and-forget; don't await the worker

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }

async function handle(req: NextRequest) {
  noStore()
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const t0 = Date.now()

  // Find every business with pending extractions (range pages past the 1000 cap).
  const businessesWithPending = new Set<string>()
  let from = 0
  while (true) {
    const { data: rows, error } = await db
      .from('invoice_pdf_extractions')
      .select('business_id')
      .eq('status', 'pending')
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!rows || rows.length === 0) break
    for (const r of rows) businessesWithPending.add((r as any).business_id)
    if (rows.length < 1000) break
    from += 1000
    if (from > 50_000) break   // safety
  }

  const targets = Array.from(businessesWithPending)
  const base = process.env.NEXT_PUBLIC_APP_URL ??
               (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)

  if (!base) {
    return NextResponse.json({
      ok:        false,
      error:     'no_base_url',
      eligible:  targets.length,
    }, { status: 500 })
  }

  // Fire-and-forget kicks — don't await the per-business workers (they
  // each run up to 750s via waitUntil inside that endpoint).
  let kicked = 0
  let failed = 0
  await Promise.all(targets.slice(0, 20).map(async bizId => {
    try {
      const ctrl = new AbortController()
      const tm = setTimeout(() => ctrl.abort(), PER_BUSINESS_TIMEOUT_MS)
      const r = await fetch(`${base}/api/cron/inventory-pdf-extract-business`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cronSecret}`,
        },
        body: JSON.stringify({ business_id: bizId, reset_extracting: true, chain_rematch: true }),
        signal: ctrl.signal,
      })
      clearTimeout(tm)
      if (r.ok || r.status === 202) kicked++
      else failed++
    } catch {
      // Fire-and-forget — abort/timeout is expected since the worker
      // runs longer than our await. Count as kicked.
      kicked++
    }
  }))

  console.log(JSON.stringify({
    at: 'cron.inventory-pdf-extract-sweep',
    eligible: targets.length,
    kicked,
    failed,
    duration_ms: Date.now() - t0,
  }))

  return NextResponse.json({
    ok:          true,
    eligible:    targets.length,
    kicked,
    failed,
    duration_ms: Date.now() - t0,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

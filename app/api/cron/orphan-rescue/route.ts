// app/api/cron/orphan-rescue/route.ts
//
// Orphan-product-rescue cron (M126). Runs hourly. For every business
// the system knows about, asks Haiku to verify whether each
// no-aliases-but-has-default-supplier product is a duplicate of an
// existing product with active aliases, and auto-merges when the
// verdict is unambiguously 'same' with high confidence.
//
// Fully automatic — no owner approval queue. Orphans the agent can't
// confidently merge stay as orphans (they remain in needs-attention,
// owner can still manually link via EditItemModal). Every decision
// is logged to orphan_rescue_log.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { runOrphanRescueForBusiness } from '@/lib/inventory/orphan-rescue'
import { logAiRequest } from '@/lib/ai/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  noStore()

  // Cron-secret auth (same pattern as every other /api/cron/*).
  const authz = req.headers.get('authorization') ?? ''
  if (authz !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY missing' }, { status: 500 })

  const db = createAdminClient()

  // Walk every active business. Cheap — one Supabase query, then the
  // orphan-rescue function is called per business.
  const { data: businesses, error } = await db.from('businesses').select('id, org_id').eq('is_active', true)
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const results: any[] = []
  let totalIn = 0, totalOut = 0
  for (const biz of businesses ?? []) {
    try {
      const r = await runOrphanRescueForBusiness(db, biz.id, apiKey)
      results.push(r)
      totalIn  += r.tokens_in
      totalOut += r.tokens_out

      // Charge the org for tokens spent on its behalf (cost dashboard
      // + monthly invoice both read from ai_request_log).
      if (r.tokens_in > 0 || r.tokens_out > 0) {
        await logAiRequest(db, {
          org_id:        biz.org_id,
          request_type:  'orphan_rescue',
          model:         'claude-haiku-4-5-20251001',
          input_tokens:  r.tokens_in,
          output_tokens: r.tokens_out,
        })
      }
    } catch (e: any) {
      results.push({ business_id: biz.id, error: e?.message ?? String(e) })
    }
  }

  return NextResponse.json({
    ok: true,
    businesses_scanned: results.length,
    total_merged: results.reduce((s, r) => s + (r.merged ?? 0), 0),
    total_tokens_in:  totalIn,
    total_tokens_out: totalOut,
    estimated_cost_usd: Math.round((totalIn * 0.000001 + totalOut * 0.000005) * 10000) / 10000,
    results,
  })
}

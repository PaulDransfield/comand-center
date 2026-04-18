// @ts-nocheck
// app/api/cron/ai-log-retention/route.ts
//
// Weekly cron that deletes ai_request_log rows older than 365 days. Part of
// GDPR minimisation — we keep enough to audit + bill, not a permanent archive.
// Cost/usage roll-ups in ai_usage_daily and ai_usage_daily_by_user are kept
// separately and are not affected by this job.
//
// Schedule (vercel.json): '0 3 * * 0' — Sunday 03:00 UTC.
// Returns: { deleted: N, cutoff: 'YYYY-MM-DD' }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const RETENTION_DAYS = 365

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}
export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}

async function run() {
  const db = createAdminClient()
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { count, error } = await db
    .from('ai_request_log')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)

  if (error) {
    console.error('[retention] ai_request_log delete failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const deleted = count ?? 0
  console.log('[retention] ai_request_log pruned', { deleted, cutoff, retention_days: RETENTION_DAYS })
  return NextResponse.json({ ok: true, deleted, cutoff: cutoff.slice(0, 10) })
}

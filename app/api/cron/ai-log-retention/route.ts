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
import { log }                       from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
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
  const started = Date.now()
  const db = createAdminClient()
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { count, error } = await db
    .from('ai_request_log')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)

  if (error) {
    log.error('ai-log-retention failed', {
      route:       'cron/ai-log-retention',
      duration_ms: Date.now() - started,
      error:       error.message,
      status:      'error',
    })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const deleted = count ?? 0
  log.info('ai-log-retention complete', {
    route:          'cron/ai-log-retention',
    duration_ms:    Date.now() - started,
    deleted,
    retention_days: RETENTION_DAYS,
    status:         'success',
  })
  return NextResponse.json({ ok: true, deleted, cutoff: cutoff.slice(0, 10) })
}

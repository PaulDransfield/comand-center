// lib/cron/log.ts
//
// Wrapper for cron handlers — records start + end + status to
// cron_run_log so the Admin v2 Health tab can show "last ran X ago".
//
// Not wired into existing cron handlers in PR 7 — that's a follow-up
// (one tiny call site per handler). Health tab gracefully reports
// "never logged" until handlers opt in.
//
// Usage (in a future cron route handler):
//
//   import { withCronLog } from '@/lib/cron/log'
//
//   export async function GET(req: NextRequest) {
//     return withCronLog('anomaly-check', async (meta) => {
//       // … real cron work; populate meta with anything useful for diagnostics
//       meta.processed = N
//       return NextResponse.json({ ok: true, processed: N })
//     })
//   }
//
// The wrapper:
//   - INSERTs a `running` row before the handler
//   - on success: UPDATE finished_at + status='success' + meta JSON
//   - on throw  : UPDATE finished_at + status='error'   + error message
//   - never blocks the response on a logging failure (Sentry-captured)

import { createAdminClient } from '@/lib/supabase/server'

export type CronMeta = Record<string, any>

export async function withCronLog<T>(
  cronName: string,
  handler: (meta: CronMeta) => Promise<T>,
): Promise<T> {
  const db   = createAdminClient()
  const meta: CronMeta = {}
  let logId: string | null = null

  // Insert the 'running' row. Failures are non-fatal — the cron still runs.
  try {
    const { data, error } = await db
      .from('cron_run_log')
      .insert({ cron_name: cronName, status: 'running' })
      .select('id')
      .maybeSingle()
    if (!error && data?.id) logId = data.id
  } catch (e: any) {
    console.warn('[cron/log] insert failed (continuing):', e?.message)
  }

  try {
    const result = await handler(meta)
    // Mark success.
    if (logId) {
      try {
        await db.from('cron_run_log').update({
          finished_at: new Date().toISOString(),
          status:      'success',
          meta:        Object.keys(meta).length ? meta : null,
        }).eq('id', logId)
      } catch (e: any) {
        console.warn('[cron/log] success update failed:', e?.message)
      }
    }
    return result
  } catch (err: any) {
    // Mark error.
    if (logId) {
      try {
        await db.from('cron_run_log').update({
          finished_at: new Date().toISOString(),
          status:      'error',
          error:       err?.message ?? String(err),
          meta:        Object.keys(meta).length ? meta : null,
        }).eq('id', logId)
      } catch (e: any) {
        console.warn('[cron/log] error update failed:', e?.message)
      }
    }
    throw err
  }
}

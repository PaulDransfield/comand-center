// app/api/cron/events-sync/route.ts
//
// Daily Stockholm events sync. Pulls the next ~60 days from Ticketmaster
// and upserts to public.events keyed on (source, source_id).
//
// Schedule: 04:00 UTC daily (vercel.json). Cron secret required.
// Idempotent — re-runs the same day are safe; upserts in place.
//
// Soft-fails when TICKETMASTER_API_KEY is missing (logged + early
// return so the cron doesn't 500 — gentler signal than a hard error
// while the env var is being provisioned).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient }           from '@/lib/supabase/server'
import { checkCronSecret }             from '@/lib/admin/check-secret'
import { withCronLog }                 from '@/lib/cron/log'
import { log }                         from '@/lib/log/structured'
import { fetchStockholmEvents, normalizeTicketmasterEvent } from '@/lib/events/ticketmaster'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60

export async function GET(req: NextRequest) {
  noStore()
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return withCronLog('events-sync', async () => {
    const apiKey = process.env.TICKETMASTER_API_KEY
    if (!apiKey) {
      log.warn('events-sync skipped: TICKETMASTER_API_KEY not set', {
        route: 'cron/events-sync',
      })
      return NextResponse.json({
        ok: true,
        skipped: 'TICKETMASTER_API_KEY not configured',
      })
    }

    const db = createAdminClient()
    const started = Date.now()
    let fetched = 0
    let normalized = 0
    let upserted = 0
    let skipped  = 0
    let errors:    string[] = []

    try {
      // Pull next 60 days of Stockholm events from Ticketmaster
      const raw = await fetchStockholmEvents({ fromDays: 0, toDays: 60 })
      fetched = raw.length

      // Normalize — skip anything missing essentials
      const normalizedEvents = []
      for (const r of raw) {
        try {
          const n = normalizeTicketmasterEvent(r)
          if (n) {
            normalizedEvents.push(n)
            normalized++
          } else {
            skipped++
          }
        } catch (e: any) {
          skipped++
          errors.push(`normalize: ${e?.message ?? String(e)}`)
        }
      }

      // Upsert in chunks of 200 (Supabase default limit + payload size)
      const CHUNK = 200
      for (let i = 0; i < normalizedEvents.length; i += CHUNK) {
        const slice = normalizedEvents.slice(i, i + CHUNK).map(n => ({
          source:              n.source,
          source_id:           n.source_id,
          name:                n.name,
          description:         n.description,
          category:            n.category,
          start_at:            n.start_at,
          end_at:              n.end_at,
          venue_name:          n.venue_name,
          venue_city:          n.venue_city,
          venue_country:       n.venue_country,
          venue_lat:           n.venue_lat,
          venue_lng:           n.venue_lng,
          expected_attendance: n.expected_attendance,
          venue_capacity:      n.venue_capacity,
          url:                 n.url,
          raw:                 n.raw,
          fetched_at:          new Date().toISOString(),
        }))
        const { error } = await db
          .from('events')
          .upsert(slice, { onConflict: 'source,source_id' })
        if (error) {
          errors.push(`upsert chunk ${i / CHUNK}: ${error.message}`)
          // Continue — partial chunk upsert is acceptable
        } else {
          upserted += slice.length
        }
      }
    } catch (e: any) {
      errors.push(`fetch: ${e?.message ?? String(e)}`)
    }

    log.info('events-sync complete', {
      route:       'cron/events-sync',
      duration_ms: Date.now() - started,
      fetched,
      normalized,
      upserted,
      skipped,
      errors:      errors.length,
      status:      errors.length === 0 ? 'success' : 'partial_failure',
    })

    return NextResponse.json({
      ok: true,
      fetched,
      normalized,
      upserted,
      skipped,
      errors,
    }, { headers: { 'Cache-Control': 'no-store' } })
  })
}

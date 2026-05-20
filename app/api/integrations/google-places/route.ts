// app/api/integrations/google-places/route.ts
//
// Connect / disconnect Google Maps for a business so the daily review-
// sync can pull reviews. Three modes:
//
//   GET  ?business_id=<uuid>              → return current Place ID + metadata
//   POST { business_id, query: "..." }    → search Places, return candidate
//   POST { business_id, place_id: "..." } → save the Place ID (after owner confirms)
//   DELETE ?business_id=<uuid>            → clear the link
//
// Auth: owner only — this is an integration setting.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { fetchPlaceReviews, searchPlaceByText } from '@/lib/reviews/google-places'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url        = new URL(req.url)
  const businessId = url.searchParams.get('business_id') ?? ''
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, google_place_id')
    .eq('id', businessId)
    .maybeSingle()

  return NextResponse.json({
    business_id:     biz?.id ?? null,
    business_name:   biz?.name ?? null,
    google_place_id: biz?.google_place_id ?? null,
    configured:      !!biz?.google_place_id,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: any = {}
  try { body = await req.json() } catch {}
  const businessId = String(body?.business_id ?? '')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()

  // Mode 1: search-by-text → return the top candidate, don't save yet
  if (body.query && !body.place_id) {
    const result = await searchPlaceByText(String(body.query))
    if (!result) {
      return NextResponse.json({
        error: 'No results — try a more specific query (e.g. "Vero Italiano Stockholm")',
      }, { status: 404 })
    }
    return NextResponse.json({ candidate: result })
  }

  // Mode 2: confirm + save
  if (body.place_id) {
    const placeId = String(body.place_id).trim()
    if (placeId.length < 5) {
      return NextResponse.json({ error: 'place_id looks invalid' }, { status: 400 })
    }

    // Verify by attempting a fetch — surfaces invalid IDs / quota errors
    // immediately rather than at next cron run.
    const probe = await fetchPlaceReviews(placeId)
    if (!probe) {
      return NextResponse.json({
        error: 'Could not fetch reviews for this Place ID. Check the ID or your Google Places API quota.',
      }, { status: 400 })
    }

    const { error } = await db
      .from('businesses')
      .update({ google_place_id: placeId, updated_at: new Date().toISOString() })
      .eq('id', businessId)
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      ok:           true,
      place_id:     placeId,
      display_name: probe.display_name,
      probe_reviews: probe.reviews.length,
    })
  }

  return NextResponse.json({ error: 'Pass either { query } or { place_id }' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const url        = new URL(req.url)
  const businessId = url.searchParams.get('business_id') ?? ''
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()
  const { error } = await db
    .from('businesses')
    .update({ google_place_id: null, updated_at: new Date().toISOString() })
    .eq('id', businessId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, cleared: true })
}

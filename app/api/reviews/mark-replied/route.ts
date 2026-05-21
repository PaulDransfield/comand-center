// app/api/reviews/mark-replied/route.ts
//
// Owner marks a review as replied. Manual workflow until Google
// Business Profile OAuth lands (which would let us detect replies
// automatically via the GBP API). Until then: owner posts the reply
// on Google, then clicks "Mark replied" here to:
//   - Set replied_at = NOW()
//   - Optionally store the reply_text (audit + future learning signal)
//   - Optionally tag the tone used
//
// POST body: { business_id, external_id, reply_text?, reply_tone?, undo? }
//
// undo=true clears the replied_at + reply_text fields (in case the
// owner clicks the button by mistake or wants to re-do the reply).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface MarkBody {
  business_id?: string
  external_id?: string
  reply_text?:  string
  reply_tone?:  'warm' | 'professional' | 'apologetic'
  undo?:        boolean
}

export async function POST(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body: MarkBody = await req.json().catch(() => ({}))
  const businessId = String(body.business_id ?? '').trim()
  const externalId = String(body.external_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!externalId) return NextResponse.json({ error: 'external_id required' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }
  if (!canAccessBusiness(subject, businessId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()

  const update = body.undo
    ? { replied_at: null, reply_text: null, reply_tone: null }
    : {
        replied_at: new Date().toISOString(),
        reply_text: body.reply_text ?? null,
        reply_tone: body.reply_tone ?? null,
      }

  const { data, error } = await db
    .from('review_themes')
    .update(update)
    .eq('business_id', businessId)
    .eq('source', 'google_places')
    .eq('external_id', externalId)
    .select('external_id, replied_at, reply_text, reply_tone')
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  }

  return NextResponse.json({
    ok: true,
    review: data,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

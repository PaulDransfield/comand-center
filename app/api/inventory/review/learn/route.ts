// app/api/inventory/review/learn/route.ts
//
// Records what the owner actually did when the AI suggested X. This is
// the learning signal: future ai-suggest calls include recent outcomes
// in the prompt as in-context examples, so the agent gradually adapts
// to this business's catalogue conventions.
//
// Fire-and-forget from the review UI — wrap each owner action (approve,
// skip, override) with a POST to this endpoint. Failure here must NEVER
// block the owner's action; the UI ignores the response.
//
// POST { business_id, group_key, ai_suggestion?, owner_action, owner_product_id?, owner_chosen_name? }

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess }        from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId   = String(body.business_id ?? '').trim()
  const groupKey     = String(body.group_key ?? '').trim()
  const ownerAction  = String(body.owner_action ?? '').trim()
  if (!businessId || !groupKey || !ownerAction) {
    return NextResponse.json({ error: 'business_id, group_key, owner_action required' }, { status: 400 })
  }
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Resolve org_id
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const ai = body.ai_suggestion ?? null
  const ownerProductId = body.owner_product_id ?? null
  const ownerChosenName = body.owner_chosen_name ? String(body.owner_chosen_name).slice(0, 200) : null

  // Compute agreement: action matches AND (if approve_existing, product_id matches)
  // AND (if create_new, name matches roughly)
  let agreed = false
  if (ai && ai.action === ownerAction) {
    if (ownerAction === 'approve_existing') {
      agreed = Boolean(ai.product_id && ownerProductId && ai.product_id === ownerProductId)
    } else if (ownerAction === 'create_new') {
      // Loose name match — same first 3 words, lowercased.
      const norm = (s: string) => s.toLowerCase().split(/\s+/).slice(0, 3).join(' ')
      agreed = Boolean(ai.suggested_name && ownerChosenName && norm(ai.suggested_name) === norm(ownerChosenName))
    } else {
      agreed = true   // skip_non_inventory / review with matching action
    }
  }

  const { error } = await db.from('inventory_review_outcomes').insert({
    org_id:             biz.org_id,
    business_id:        businessId,
    group_key:          groupKey,
    ai_action:          ai?.action ?? null,
    ai_confidence:      ai?.confidence ?? null,
    ai_product_id:      ai?.product_id ?? null,
    ai_suggested_name:  ai?.suggested_name ?? null,
    owner_action:       ownerAction,
    owner_product_id:   ownerProductId,
    owner_chosen_name:  ownerChosenName,
    agreed,
  })
  if (error) {
    console.error('[review/learn] insert failed:', error.message)
    // Soft-fail — outcome logging must never block owner actions.
    return NextResponse.json({ ok: false, error: error.message }, { status: 200 })
  }

  return NextResponse.json({ ok: true, agreed })
}

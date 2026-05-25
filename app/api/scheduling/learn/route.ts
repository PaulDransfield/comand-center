// app/api/scheduling/learn/route.ts
//
// POST /api/scheduling/learn { suggestion_id, action, reason?, modified_to? }
//
// Records owner decision on an AI scheduling suggestion. Fire-and-forget
// from the grid UI — failure must NEVER block the owner action.
//
// action: 'approved' | 'modified' | 'rejected' | 'applied'
//
// The learning loop: next /api/scheduling/ai-recommend run pulls the
// last 60 days of 'rejected' + 'modified' rows and includes them in
// the prompt as in-context examples. Owner modifications are the
// strongest signal — they show what the AI got CLOSE but not right.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const suggestionId = String(body.suggestion_id ?? '').trim()
  const action       = String(body.action ?? '').trim()
  const reason       = body.reason ? String(body.reason).slice(0, 500) : null
  const modifiedTo   = body.modified_to ?? null

  if (!suggestionId) return NextResponse.json({ error: 'suggestion_id required' }, { status: 400 })
  if (!['approved', 'modified', 'rejected', 'applied'].includes(action)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify ownership — the suggestion's business must belong to the user's org
  const { data: sugg } = await db
    .from('schedule_ai_suggestions')
    .select('id, business_id, org_id')
    .eq('id', suggestionId)
    .maybeSingle()
  if (!sugg) return NextResponse.json({ error: 'suggestion not found' }, { status: 404 })
  if (sugg.org_id !== auth.orgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { error } = await db
    .from('schedule_ai_suggestions')
    .update({
      status:          action,
      owner_action_at: new Date().toISOString(),
      owner_action_by: auth.userId ?? null,
      owner_reason:    reason,
      modified_to:     modifiedTo,
    })
    .eq('id', suggestionId)
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}

// @ts-nocheck
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

async function getAuth(req: NextRequest) {
  const raw = req.cookies.get('sb-llzmixkrysduztsvmfzi-auth-token')?.value
  if (!raw) return null
  try {
    let token = raw
    try {
      const decoded = decodeURIComponent(raw)
      const parsed  = JSON.parse(decoded)
      token = Array.isArray(parsed) ? parsed[0] : (parsed.access_token ?? raw)
    } catch {}
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(token)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    return m ? { userId: user.id, orgId: m.org_id } : null
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const {
    name, type, city, org_number, colour,
    target_food_pct, target_staff_pct, target_margin_pct,
  } = body

  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const db = createAdminClient()

  const { data, error } = await db
    .from('businesses')
    .insert({
      org_id:            auth.orgId,
      name:              name.trim(),
      type:              type || 'restaurant',
      city:              city || null,
      org_number:        org_number || null,
      colour:            colour || '#1A3F6B',
      currency:          'SEK',
      is_active:         true,
      target_food_pct:   target_food_pct   ?? 31,
      target_staff_pct:  target_staff_pct  ?? 35,
      target_margin_pct: target_margin_pct ?? 15,
    })
    .select('id, name')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to save business' }, { status: 500 })

  return NextResponse.json(data)
}

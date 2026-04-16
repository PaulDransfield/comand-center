// @ts-nocheck
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

const getAuth = getRequestAuth

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

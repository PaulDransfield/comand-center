// @ts-nocheck
export const dynamic = 'force-dynamic'
export const revalidate = 0

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  // Auth via cookie
  const cookieName  = `sb-llzmixkrysduztsvmfzi-auth-token`
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let userId: string
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const adminDb     = createAdminClient()
    const { data: { user } } = await adminDb.auth.getUser(accessToken)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    userId = user.id
  } catch (e: any) {
    return NextResponse.json({ error: 'Auth failed' }, { status: 401 })
  }

  const { name, type, city, org_number, colour } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const adminDb = createAdminClient()

  // Get the org for this user
  const { data: membership } = await adminDb
    .from('organisation_members')
    .select('org_id')
    .eq('user_id', userId)
    .single()

  if (!membership) return NextResponse.json({ error: 'No organisation found' }, { status: 404 })

  const { data, error } = await adminDb
    .from('businesses')
    .insert({
      org_id:     membership.org_id,
      name:       name.trim(),
      type:       type || 'Restaurant',
      city:       city || null,
      org_number: org_number || null,
      colour:     colour || '#1A3F6B',
      currency:   'SEK',
      is_active:  true,
    })
    .select('id, name')
    .single()

  if (error) {
    console.error('Add business error:', error)
    return NextResponse.json({ error: 'Failed to save business' }, { status: 500 })
  }

  return NextResponse.json(data)
}
// Already has: export const dynamic = 'force-dynamic'

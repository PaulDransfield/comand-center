// app/api/cron/test-digest/route.ts
// Send a test digest email to the current user immediately
// Used from the Settings page to preview the email

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const cookieName  = 'sb-llzmixkrysduztsvmfzi-auth-token'
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let userId = '', orgId = '', userEmail = ''
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(accessToken)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    userId    = user.id
    userEmail = user.email ?? ''
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', userId).single()
    if (!m) return NextResponse.json({ error: 'No org' }, { status: 404 })
    orgId = m.org_id
  } catch { return NextResponse.json({ error: 'Auth failed' }, { status: 401 }) }

  // Trigger the weekly digest for just this org with a test flag
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const res = await fetch(`${appUrl}/api/cron/weekly-digest?secret=${process.env.CRON_SECRET}&org_id=${orgId}&to=${userEmail}`, {
    headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' }
  })

  const data = await res.json()
  return NextResponse.json({ ok: true, message: `Test digest sent to ${userEmail}`, ...data })
}

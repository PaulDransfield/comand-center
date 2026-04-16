// app/api/cron/test-digest/route.ts
// Send a test digest email to the current user immediately
// Used from the Settings page to preview the email

import { NextRequest, NextResponse }          from 'next/server'
import { createAdminClient, getRequestAuth }  from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const { userId, orgId } = auth

  // Look up the user's email (needed to send the digest)
  const db = createAdminClient()
  const { data: userRow } = await db.from('users').select('email').eq('id', userId).single()
  const userEmail = userRow?.email ?? ''

  // Trigger the weekly digest for just this org with a test flag
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const res = await fetch(`${appUrl}/api/cron/weekly-digest?secret=${process.env.CRON_SECRET}&org_id=${orgId}&to=${userEmail}`, {
    headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' }
  })

  const data = await res.json()
  return NextResponse.json({ ok: true, message: `Test digest sent to ${userEmail}`, ...data })
}

// app/api/auth/callback/route.ts
//
// Handles the redirect after a user clicks the email verification link.
// Supabase sends an email with a link to:
//   https://yourapp.com/api/auth/callback?code=abc123
//
// This route exchanges that code for a real login session,
// then redirects the user to the dashboard.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)

  const code       = searchParams.get('code')
  const explicitNext = searchParams.get('next')
  const errorParam = searchParams.get('error')

  // Handle errors from Supabase (e.g. link expired)
  if (errorParam) {
    console.error('Auth callback error:', errorParam, searchParams.get('error_description'))
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Email link expired. Please request a new one.')}`
    )
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=Missing+verification+code`)
  }

  const supabase = createClient()

  // Exchange the one-time code for a session
  // This sets the session cookies so the user is logged in
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    console.error('Session exchange failed:', error.message)
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('Verification failed. Please try again.')}`
    )
  }

  // Role-aware default landing. If the caller passed an explicit `next=`,
  // honour it (the invite flow uses next=/revisor for revisor invites).
  // Otherwise look up the user's role and route revisors to /revisor —
  // dropping them on /dashboard would just bounce them through RoleGate
  // to the access-restricted page.
  let finalNext = explicitNext ?? '/dashboard'
  if (!explicitNext) {
    try {
      const { data: userRes } = await supabase.auth.getUser()
      const userId = userRes?.user?.id
      if (userId) {
        const admin = createAdminClient()
        const { data: member } = await admin
          .from('organisation_members')
          .select('role')
          .eq('user_id', userId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle()
        if ((member as any)?.role === 'revisor') {
          finalNext = '/revisor'
        }
      }
    } catch {
      // Best-effort role lookup. If it fails, fall through to /dashboard;
      // RoleGate will catch revisors there and (after the fix below)
      // redirect them properly.
    }
  }

  return NextResponse.redirect(`${origin}${finalNext}`)
}

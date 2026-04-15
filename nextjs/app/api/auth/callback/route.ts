// @ts-nocheck
// app/api/auth/callback/route.ts
//
// Handles the redirect after a user clicks the email verification link.
// Supabase sends an email with a link to:
//   https://yourapp.com/api/auth/callback?code=abc123
//
// This route exchanges that code for a real login session,
// then redirects the user to the dashboard.

import { NextRequest, NextResponse } from 'next/server'
import { createClient }              from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)

  const code       = searchParams.get('code')
  const next       = searchParams.get('next') ?? '/dashboard'  // where to go after login
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

  // Success â€” redirect to the dashboard (or wherever they were headed)
  return NextResponse.redirect(`${origin}${next}`)
}

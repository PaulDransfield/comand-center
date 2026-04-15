// app/api/auth/signup/route.ts
//
// Handles new account creation.
// One API call creates: the auth user, the organisation, and the owner membership.
//
// Called by the signup form with:
//   POST /api/auth/signup
//   { email, password, fullName, orgName }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)

  // Validate that all required fields are present
  const { email, password, fullName, orgName } = body ?? {}
  if (!email || !password || !orgName) {
    return NextResponse.json(
      { error: 'Email, password, and organisation name are required.' },
      { status: 400 }
    )
  }

  // Basic password strength: at least 8 characters
  if (password.length < 8) {
    return NextResponse.json(
      { error: 'Password must be at least 8 characters.' },
      { status: 400 }
    )
  }

  const supabase = createAdminClient()

  // ── STEP 1: Create the Supabase auth user ─────────────────────
  // This handles password hashing, email verification, etc.
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: false,  // sends a verification email — they must click it to log in
    user_metadata: { full_name: fullName },
  })

  if (authError) {
    // Check for the most common error: email already in use
    if (authError.message?.toLowerCase().includes('already registered')) {
      return NextResponse.json(
        { error: 'An account with this email already exists. Try logging in instead.' },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: authError.message }, { status: 400 })
  }

  const userId = authData.user.id

  // ── STEP 2: Create the user profile ───────────────────────────
  await supabase.from('users').insert({
    id:           userId,
    email,
    full_name:    fullName || null,
    auth_methods: ['email'],
  })

  // ── STEP 3: Create the organisation ───────────────────────────
  // The slug is a URL-safe version of the org name (used in URLs later)
  const rawSlug    = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const uniqueSlug = `${rawSlug}-${Date.now().toString(36)}`  // appending a short random suffix prevents duplicates

  const now      = new Date()
  const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)  // 30 days from now

  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .insert({
      name:        orgName,
      slug:        uniqueSlug,
      plan:        'trial',
      trial_start: now.toISOString(),
      trial_end:   trialEnd.toISOString(),
      is_active:   true,
    })
    .select('id')
    .single()

  if (orgError) {
    // If the org creation fails, clean up the auth user so they can try again
    await supabase.auth.admin.deleteUser(userId)
    console.error('Org creation failed:', orgError)
    return NextResponse.json(
      { error: 'Failed to create your organisation. Please try again.' },
      { status: 500 }
    )
  }

  // ── STEP 4: Make this user the owner of the organisation ───────
  await supabase.from('organisation_members').insert({
    org_id:      org.id,
    user_id:     userId,
    role:        'owner',
    accepted_at: now.toISOString(),
  })

  // ── STEP 5: Create onboarding progress record ──────────────────
  // This tracks where they are in the 6-step onboarding wizard
  await supabase.from('onboarding_progress').insert({
    org_id:          org.id,
    current_step:    1,
    steps_completed: [],
  })

  // ── DONE ───────────────────────────────────────────────────────
  return NextResponse.json({
    message:    'Account created. Please check your email to verify your address.',
    orgId:      org.id,
    trialDays:  30,
    trialEnd:   trialEnd.toISOString(),
  })
}

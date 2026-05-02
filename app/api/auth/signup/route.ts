// app/api/auth/signup/route.ts
//
// Handles new account creation.
// One API call creates: the auth user, the organisation, and the owner membership.
//
// Called by the signup form with:
//   POST /api/auth/signup
//   { email, password, fullName, orgName, orgNumber? }
//
// orgNumber is OPTIONAL since M046 — the onboarding wizard now owns the
// business-context capture (address, opening days, stage, etc.) and
// org-nr collection moved there too. Signup stays at the bare minimum
// (email/password/name/org-name) to keep the very first form short.
// We still accept the field for backward compat with any in-flight old
// clients and for manual signups that want to set it up front.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { rateLimit }                 from '@/lib/middleware/rate-limit'
import { validateOrgNr }             from '@/lib/sweden/orgnr'

export async function POST(req: NextRequest) {
  // Rate-limit by IP — prevents signup flooding / org spam.
  // Five signups per IP per hour is already generous.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
          ?? req.headers.get('x-real-ip')
          ?? 'unknown'
  const gate = rateLimit(`signup:${ip}`, { windowMs: 60 * 60_000, max: 5 })
  if (!gate.allowed) {
    return NextResponse.json({ error: 'Too many signups from this IP. Try again later.' }, { status: 429 })
  }

  const body = await req.json().catch(() => null)

  // Validate that all required fields are present
  const { email, password, fullName, orgName, orgNumber } = body ?? {}
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

  // M046: org-nr capture moved to the onboarding wizard, so it's optional
  // here. If the caller still sends one (legacy form, manual signup),
  // validate it — silently dropping a bad value would surprise the user
  // when they later try to use the product. If absent, we just skip the
  // check and let onboarding collect it.
  let validatedOrgNr: string | null = null
  if (orgNumber !== undefined && orgNumber !== null && String(orgNumber).trim() !== '') {
    const orgNrCheck = validateOrgNr(orgNumber)
    if (!orgNrCheck.ok) {
      return NextResponse.json(
        { error: `Organisationsnummer: ${orgNrCheck.error}` },
        { status: 400 }
      )
    }
    validatedOrgNr = orgNrCheck.value
  }

  const supabase = createAdminClient()

  // ── STEP 1: Create the Supabase auth user ─────────────────────
  // This handles password hashing, email verification, etc.
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,   // auto-confirm — user can log in immediately after signup
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

  const orgInsert: Record<string, any> = {
    name:        orgName,
    slug:        uniqueSlug,
    plan:        'trial',
    trial_start: now.toISOString(),
    trial_end:   trialEnd.toISOString(),
    is_active:   true,
  }
  // Only set org_number when the caller provided it. Onboarding will
  // write it later via /api/onboarding/complete → applyOrgNumberToOrg
  // for new signups.
  if (validatedOrgNr) {
    orgInsert.org_number        = validatedOrgNr
    orgInsert.org_number_set_at = now.toISOString()
  }

  const { data: org, error: orgError } = await supabase
    .from('organisations')
    .insert(orgInsert)
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
    message:    'Account created successfully.',
    orgId:      org.id,
    trialDays:  30,
    trialEnd:   trialEnd.toISOString(),
  })
}

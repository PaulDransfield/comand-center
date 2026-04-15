// ═══════════════════════════════════════════════════════════════════
// COMMAND CENTER — NEXT.JS + SUPABASE COMPLETE SETUP
// ═══════════════════════════════════════════════════════════════════
//
// This file contains every config file you need.
// Each section is labelled with the path where it goes in your project.
// ═══════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────
// FILE: package.json  (root of your project)
// ───────────────────────────────────────────────────────────────────
const packageJson = {
  "name": "command-center",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev":   "next dev",
    "build": "next build",
    "start": "next start",
    "lint":  "next lint"
  },
  "dependencies": {
    "next":                       "14.2.0",
    "react":                      "^18.3.0",
    "react-dom":                  "^18.3.0",
    "@supabase/supabase-js":      "^2.43.0",
    "@supabase/ssr":              "^0.3.0",
    "@anthropic-ai/sdk":          "^0.24.0",
    "docx":                       "^9.5.3",
    "openpyxl":                   null,
    "stripe":                     "^15.0.0",
    "resend":                     "^3.2.0",
    "micro":                      "^10.0.1",
    "gpt-tokenizer":              "^2.1.2",
    "mammoth":                    "^1.7.0",
    "xlsx":                       "^0.18.5"
  },
  "devDependencies": {
    "@types/node":    "^20.0.0",
    "@types/react":   "^18.0.0",
    "typescript":     "^5.0.0",
    "eslint":         "^8.0.0",
    "eslint-config-next": "14.2.0"
  }
};

// ───────────────────────────────────────────────────────────────────
// FILE: .env.local  (never commit this file — add to .gitignore)
// ───────────────────────────────────────────────────────────────────
const envLocal = `
# ── SUPABASE ──────────────────────────────────────────────────────
# Get these from: supabase.com → your project → Settings → API
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...YOUR_ANON_KEY...
SUPABASE_SERVICE_ROLE_KEY=eyJ...YOUR_SERVICE_ROLE_KEY...

# ── ANTHROPIC ─────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-...

# ── STRIPE ────────────────────────────────────────────────────────
STRIPE_SECRET_KEY=sk_test_...            # Use sk_live_ in production
STRIPE_WEBHOOK_SECRET=whsec_...          # From Stripe → Webhooks
STRIPE_PRICE_STARTER=price_...          # Create in Stripe Dashboard
STRIPE_PRICE_PRO=price_...

# ── EMAIL ─────────────────────────────────────────────────────────
RESEND_API_KEY=re_...                     # From resend.com

# ── SECURITY ─────────────────────────────────────────────────────
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CREDENTIAL_ENCRYPTION_KEY=64_char_hex_string_here
PERSONNUMMER_HMAC_SECRET=another_64_char_hex_string_here
CRON_SECRET=any_random_string_for_cron_auth

# ── APP ───────────────────────────────────────────────────────────
NEXT_PUBLIC_APP_URL=http://localhost:3000   # https://yourapp.com in production

# ── BANKID (optional — Phase 2) ──────────────────────────────────
# SIGNICAT_CLIENT_ID=...
# SIGNICAT_CLIENT_SECRET=...
`;

// ───────────────────────────────────────────────────────────────────
// FILE: lib/supabase/client.ts
// Browser-side Supabase client (for React components)
// ───────────────────────────────────────────────────────────────────
export const supabaseClientCode = `
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
`;

// ───────────────────────────────────────────────────────────────────
// FILE: lib/supabase/server.ts
// Server-side Supabase client (for API routes and Server Components)
// ───────────────────────────────────────────────────────────────────
export const supabaseServerCode = `
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export function createClient() {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll:    () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try { cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) }
          catch {}
        },
      },
    }
  )
}

// Admin client — bypasses RLS. Server-side only. Never expose to browser.
export function createAdminClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  )
}
`;

// ───────────────────────────────────────────────────────────────────
// FILE: middleware.ts  (root of project, next to package.json)
// Protects all routes — redirects unauthenticated users to /login
// ───────────────────────────────────────────────────────────────────
export const middlewareCode = `
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Routes that don't need authentication
const PUBLIC_ROUTES = ['/login', '/signup', '/forgot-password', '/reset-password',
  '/api/auth', '/api/webhooks']

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })
  const pathname = request.nextUrl.pathname

  // Skip auth check for public routes
  const isPublic = PUBLIC_ROUTES.some(r => pathname.startsWith(r))
  if (isPublic) return supabaseResponse

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll:  () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options))
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('redirectTo', pathname)
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
`;

// ───────────────────────────────────────────────────────────────────
// FILE: lib/auth/get-org.ts
// Used in every API route to get the authenticated org
// ───────────────────────────────────────────────────────────────────
export const getOrgCode = `
import { createAdminClient } from '@/lib/supabase/server'

export interface OrgContext {
  userId: string
  orgId:  string
  role:   'owner' | 'admin' | 'viewer'
  plan:   string
}

/**
 * getOrgFromRequest(req)
 * Extracts org context from Bearer token in Authorization header.
 * Use at the top of every API route.
 */
export async function getOrgFromRequest(req: Request): Promise<OrgContext | null> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return null

  const supabase = createAdminClient()

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null

  const { data: membership } = await supabase
    .from('organisation_members')
    .select('org_id, role, organisations(plan)')
    .eq('user_id', user.id)
    .single()

  if (!membership) return null

  return {
    userId: user.id,
    orgId:  membership.org_id,
    role:   membership.role as OrgContext['role'],
    plan:   (membership.organisations as any)?.plan || 'trial',
  }
}

/**
 * requireRole(ctx, minRole)
 * Throws 403 if user doesn't have sufficient role.
 * Role hierarchy: owner > admin > viewer
 */
export function requireRole(ctx: OrgContext, minRole: 'admin' | 'owner') {
  const RANK = { viewer: 0, admin: 1, owner: 2 }
  if (RANK[ctx.role] < RANK[minRole]) {
    throw new Response('Forbidden', { status: 403 })
  }
}
`;

// ───────────────────────────────────────────────────────────────────
// FILE: app/api/auth/signup/route.ts
// Creates a new user + org + starts trial
// ───────────────────────────────────────────────────────────────────
export const signupRouteCode = `
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function POST(req: NextRequest) {
  const { email, password, fullName, orgName } = await req.json()

  if (!email || !password || !orgName) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const supabase = createAdminClient()

  // 1. Create the auth user
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: false,          // sends verification email
    user_metadata: { full_name: fullName },
  })

  if (authError) {
    // Check for duplicate email
    if (authError.message?.includes('already registered')) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: authError.message }, { status: 400 })
  }

  const userId = authData.user.id

  // 2. Create the user profile
  await supabase.from('users').insert({
    id:         userId,
    email,
    full_name:  fullName,
    auth_methods: ['email'],
  })

  // 3. Create the organisation
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const uniqueSlug = slug + '-' + Date.now().toString(36)

  const now      = new Date()
  const trialEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

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
    .select()
    .single()

  if (orgError) {
    // Roll back user creation
    await supabase.auth.admin.deleteUser(userId)
    return NextResponse.json({ error: 'Failed to create organisation' }, { status: 500 })
  }

  // 4. Make the user owner of the org
  await supabase.from('organisation_members').insert({
    org_id:      org.id,
    user_id:     userId,
    role:        'owner',
    accepted_at: now.toISOString(),
  })

  // 5. Create onboarding progress record
  await supabase.from('onboarding_progress').insert({
    org_id:          org.id,
    current_step:    1,
    steps_completed: [],
  })

  return NextResponse.json({
    message:   'Account created. Check your email to verify.',
    orgId:     org.id,
    trialDays: 30,
  })
}
`;

// ───────────────────────────────────────────────────────────────────
// FILE: app/api/auth/callback/route.ts
// Handles email confirmation redirects from Supabase
// ───────────────────────────────────────────────────────────────────
export const callbackRouteCode = `
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code  = searchParams.get('code')
  const next  = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(\`\${origin}\${next}\`)
    }
  }
  return NextResponse.redirect(\`\${origin}/login?error=auth_callback_failed\`)
}
`;

// ───────────────────────────────────────────────────────────────────
// FILE: vercel.json  (root of project)
// Configures cron jobs for scheduled exports and trial emails
// ───────────────────────────────────────────────────────────────────
export const vercelJson = {
  "crons": [
    {
      "path":     "/api/cron/trial-emails",
      "schedule": "0 9 * * *"      // Daily at 09:00 UTC (11:00 Stockholm)
    },
    {
      "path":     "/api/cron/scheduled-exports",
      "schedule": "0 * * * *"      // Hourly — checks for due exports
    },
    {
      "path":     "/api/cron/fortnox-sync",
      "schedule": "0 6 * * *"      // Daily Fortnox data sync at 06:00
    }
  ]
};

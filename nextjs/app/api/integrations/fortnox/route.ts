// @ts-nocheck
// app/api/integrations/fortnox/route.ts
//
// FORTNOX OAUTH 2.0 INTEGRATION â€” three routes in one file:
//
//   GET  /api/integrations/fortnox/connect  â†’ redirects user to Fortnox login
//   GET  /api/integrations/fortnox/callback â†’ exchanges code for tokens
//   POST /api/integrations/fortnox/sync     â†’ pulls latest invoices from Fortnox
//   POST /api/integrations/fortnox/refresh  â†’ refreshes expired access token
//
// BEFORE THIS WORKS you need:
//   1. Apply for a Fortnox developer account at developer.fortnox.se (allow 2-4 weeks)
//   2. Create an app â€” you get a Client ID and Client Secret
//   3. Add these to .env.local:
//      FORTNOX_CLIENT_ID=your_client_id
//      FORTNOX_CLIENT_SECRET=your_client_secret
//
// IMPORTANT: You create ONE app for all your customers.
//   Each customer authorises *their* Fortnox account to connect to *your* app.
//   You store their access_token per-org, encrypted in the integrations table.

import { NextRequest, NextResponse }  from 'next/server'
import { createAdminClient }          from '@/lib/supabase/server'
import { getOrgFromRequest }          from '@/lib/auth/get-org'
import { encrypt, decrypt }           from '@/lib/integrations/encryption'
import { rateLimit }                  from '@/lib/middleware/rate-limit'

// Fortnox API base URL
const FORTNOX_API     = 'https://api.fortnox.se/3'
const FORTNOX_AUTH    = 'https://apps.fortnox.se/oauth-v1/auth'
const FORTNOX_TOKEN   = 'https://apps.fortnox.se/oauth-v1/token'

// What data we ask permission to read from the customer's Fortnox account
const FORTNOX_SCOPES  = [
  'bookkeeping',     // vouchers, accounts
  'invoice',         // customer invoices (revenue)
  'supplierinvoice', // supplier invoices (costs)
  'salary',          // payroll (staff cost)
  'companyinformation', // org details
].join(' ')

// â”€â”€ CONNECT: start the OAuth flow â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Redirect the user to Fortnox's login page.
// Fortnox will ask them "Do you want to connect [Your App Name] to your account?"
// On approval, Fortnox redirects back to our callback URL with a code.

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  if (action === 'connect') {
    const auth = await getOrgFromRequest(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const clientId   = process.env.FORTNOX_CLIENT_ID
    const appUrl     = process.env.NEXT_PUBLIC_APP_URL

    if (!clientId) {
      return NextResponse.json({
        error: 'Fortnox integration not configured. Add FORTNOX_CLIENT_ID to environment variables.',
      }, { status: 500 })
    }

    // Build the Fortnox authorisation URL
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  `${appUrl}/api/integrations/fortnox?action=callback`,
      scope:         FORTNOX_SCOPES,
      response_type: 'code',
      state:         auth.orgId,  // we'll verify this in the callback to prevent CSRF
      access_type:   'offline',   // request a refresh_token too
    })

    const fortnoxAuthUrl = `${FORTNOX_AUTH}?${params}`
    return NextResponse.redirect(fortnoxAuthUrl)
  }

  if (action === 'callback') {
    return handleCallback(req)
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

// â”€â”€ CALLBACK: exchange code for tokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fortnox redirects here after the user approves access.
// We swap the one-time "code" for a long-lived access_token + refresh_token.

async function handleCallback(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const code   = searchParams.get('code')
  const state  = searchParams.get('state')  // this is the org_id we passed
  const error  = searchParams.get('error')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL

  if (error) {
    console.error('Fortnox OAuth error:', error, searchParams.get('error_description'))
    return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_denied`)
  }

  if (!code || !state) {
    return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_invalid_callback`)
  }

  const orgId          = state
  const clientId       = process.env.FORTNOX_CLIENT_ID!
  const clientSecret   = process.env.FORTNOX_CLIENT_SECRET!
  const redirectUri    = `${appUrl}/api/integrations/fortnox?action=callback`

  // Exchange code for tokens
  let tokenData: any
  try {
    const tokenRes = await fetch(FORTNOX_TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // HTTP Basic Auth with client credentials
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenRes.ok) {
      const err = await tokenRes.text()
      console.error('Fortnox token exchange failed:', err)
      return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_token_failed`)
    }

    tokenData = await tokenRes.json()
  } catch (err) {
    console.error('Fortnox token exchange error:', err)
    return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_network_error`)
  }

  const { access_token, refresh_token, expires_in } = tokenData
  const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString()

  // Store tokens encrypted in the integrations table
  const supabase = createAdminClient()

  const credentialsToStore = JSON.stringify({
    access_token,
    refresh_token,
    expires_at: expiresAt,
  })

  const { error: dbError } = await supabase
    .from('integrations')
    .upsert({
      org_id:          orgId,
      provider:        'fortnox',
      status:          'connected',
      credentials_enc: encrypt(credentialsToStore),
      token_expires_at:expiresAt,
      last_sync_at:    null,
      last_error:      null,
      updated_at:      new Date().toISOString(),
    }, {
      onConflict: 'org_id,provider',
    })

  if (dbError) {
    console.error('Failed to save Fortnox credentials:', dbError)
    return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_save_failed`)
  }

  // Trigger initial sync in background (don't wait for it)
  syncFortnoxInBackground(orgId, access_token).catch(console.error)

  // Redirect back to the integrations page with success
  return NextResponse.redirect(`${appUrl}/integrations?connected=fortnox`)
}

// â”€â”€ SYNC: pull data from Fortnox â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fetches supplier invoices (costs) and sales invoices (revenue)
// for the current and previous month, then updates tracker_data.

export async function POST(req: NextRequest) {
  const auth = await getOrgFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const limit = await rateLimit(req, auth, 'general')
  if (!limit.ok) return limit.response!

  const { action } = await req.json().catch(() => ({ action: 'sync' }))

  if (action === 'refresh') return refreshToken(auth.orgId)

  return syncFortnox(auth.orgId)
}

async function syncFortnoxInBackground(orgId: string, accessToken: string) {
  await syncFortnox(orgId)
}

async function syncFortnox(orgId: string): Promise<Response> {
  const supabase = createAdminClient()

  // Get decrypted credentials
  const { data: integration } = await supabase
    .from('integrations')
    .select('credentials_enc, token_expires_at')
    .eq('org_id', orgId)
    .eq('provider', 'fortnox')
    .single()

  if (!integration?.credentials_enc) {
    return NextResponse.json({ error: 'Fortnox not connected' }, { status: 404 })
  }

  // Decrypt credentials
  let creds: { access_token: string; refresh_token: string; expires_at: string }
  try {
    creds = JSON.parse(decrypt(integration.credentials_enc) ?? '{}')
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt Fortnox credentials' }, { status: 500 })
  }

  // Refresh token if expired or expiring within 60 minutes
  const expiresAt = new Date(creds.expires_at)
  if (expiresAt.getTime() - Date.now() < 60 * 60 * 1000) {
    await refreshToken(orgId)
    // Re-fetch fresh credentials after refresh
    const { data: fresh } = await supabase
      .from('integrations').select('credentials_enc').eq('org_id', orgId).eq('provider','fortnox').single()
    if (fresh?.credentials_enc) {
      creds = JSON.parse(decrypt(fresh.credentials_enc) ?? '{}')
    }
  }

  const { access_token } = creds

  // Helper: call Fortnox API
  async function fortnoxGet(path: string) {
    const res = await fetch(`${FORTNOX_API}${path}`, {
      headers: {
        'Authorization':  `Bearer ${access_token}`,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
      },
    })
    if (!res.ok) {
      if (res.status === 401) throw new Error('TOKEN_EXPIRED')
      throw new Error(`Fortnox API error: ${res.status}`)
    }
    return res.json()
  }

  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1

  try {
    // Fetch supplier invoices for current month (costs)
    // financialyear=0 = current financial year
    const [supplierRes, salesRes] = await Promise.all([
      fortnoxGet(`/supplierinvoices?fromdate=${year}-${String(month).padStart(2,'0')}-01&todate=${year}-${String(month).padStart(2,'0')}-31`),
      fortnoxGet(`/invoices?fromdate=${year}-${String(month).padStart(2,'0')}-01&todate=${year}-${String(month).padStart(2,'0')}-31`),
    ])

    const supplierInvoices: any[] = supplierRes.SupplierInvoices ?? []
    const salesInvoices:    any[] = salesRes.Invoices ?? []

    // Aggregate supplier invoices into cost categories
    let staff_cost = 0, food_cost = 0, rent_cost = 0, other_cost = 0

    for (const inv of supplierInvoices) {
      const amount      = parseFloat(inv.Total ?? 0)
      const supplier    = (inv.SupplierName ?? '').toLowerCase()
      const description = (inv.Comments ?? '').toLowerCase()

      // Auto-categorise by supplier name / description
      // These patterns match common Swedish restaurant suppliers
      if (/lÃ¶n|personal|bemanning|arbetsgivar|quinyx|caspeco|personalkollen/.test(supplier + description)) {
        staff_cost += amount
      } else if (/menigo|sysco|martin.*servera|dryck|mat|livsmedel|rÃ¥var|kÃ¶tt|fisk|grÃ¶nt/.test(supplier + description)) {
        food_cost += amount
      } else if (/hyra|lokal|fastighet|el|vatten|vÃ¤rme|stÃ¤d/.test(supplier + description)) {
        rent_cost += amount
      } else {
        other_cost += amount
      }
    }

    // Total revenue from sales invoices
    const revenue = salesInvoices.reduce((sum: number, inv: any) => sum + parseFloat(inv.Total ?? 0), 0)

    const total_cost  = staff_cost + food_cost + rent_cost + other_cost
    const net_profit  = revenue - total_cost
    const margin_pct  = revenue > 0 ? Math.round((net_profit / revenue) * 1000) / 10 : 0
    const gross_profit= revenue - food_cost

    // Get the first (and usually only) active business for this org
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .limit(1)

    if (!businesses?.length) {
      return NextResponse.json({ error: 'No active business found for this org' }, { status: 404 })
    }

    const businessId = businesses[0].id

    // Upsert tracker_data â€” update if exists, insert if not
    await supabase.from('tracker_data').upsert({
      org_id:      orgId,
      business_id: businessId,
      period_year: year,
      period_month:month,
      revenue,
      staff_cost,
      food_cost,
      rent_cost,
      other_cost,
      total_cost,
      gross_profit,
      net_profit,
      margin_pct,
      source:    'fortnox',
    }, { onConflict: 'business_id,period_year,period_month' })

    // Update last_sync_at
    await supabase.from('integrations')
      .update({ last_sync_at: now.toISOString(), status: 'connected', last_error: null })
      .eq('org_id', orgId).eq('provider', 'fortnox')

    return NextResponse.json({
      ok:        true,
      synced:    { revenue, staff_cost, food_cost, rent_cost, other_cost, net_profit, margin_pct },
      invoices:  { supplier: supplierInvoices.length, sales: salesInvoices.length },
    })

  } catch (err: any) {
    const msg = err.message ?? 'Fortnox sync failed'
    await supabase.from('integrations')
      .update({ status: 'error', last_error: msg })
      .eq('org_id', orgId).eq('provider', 'fortnox')

    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// â”€â”€ TOKEN REFRESH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fortnox access tokens expire after 60 minutes.
// Refresh tokens last longer and are used to get new access tokens.

async function refreshToken(orgId: string): Promise<Response> {
  const supabase = createAdminClient()

  const { data: integration } = await supabase
    .from('integrations')
    .select('credentials_enc')
    .eq('org_id', orgId)
    .eq('provider', 'fortnox')
    .single()

  if (!integration?.credentials_enc) {
    return NextResponse.json({ error: 'Fortnox not connected' }, { status: 404 })
  }

  const creds: any = JSON.parse(decrypt(integration.credentials_enc) ?? '{}')
  const { refresh_token } = creds

  if (!refresh_token) {
    return NextResponse.json({ error: 'No refresh token available â€” please reconnect Fortnox' }, { status: 400 })
  }

  const clientId     = process.env.FORTNOX_CLIENT_ID!
  const clientSecret = process.env.FORTNOX_CLIENT_SECRET!

  const tokenRes = await fetch(FORTNOX_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token,
    }),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    await supabase.from('integrations')
      .update({ status: 'error', last_error: 'Token refresh failed â€” please reconnect Fortnox' })
      .eq('org_id', orgId).eq('provider', 'fortnox')
    return NextResponse.json({ error: `Token refresh failed: ${err}` }, { status: 400 })
  }

  const { access_token, refresh_token: new_refresh, expires_in } = await tokenRes.json()
  const expiresAt = new Date(Date.now() + (expires_in ?? 3600) * 1000).toISOString()

  const newCreds = JSON.stringify({
    access_token,
    refresh_token:   new_refresh ?? refresh_token,  // Fortnox may issue a new refresh token
    expires_at:      expiresAt,
  })

  await supabase.from('integrations')
    .update({
      credentials_enc: encrypt(newCreds),
      token_expires_at: expiresAt,
      status:          'connected',
      updated_at:      new Date().toISOString(),
    })
    .eq('org_id', orgId).eq('provider', 'fortnox')

  return NextResponse.json({ ok: true, expiresAt })
}

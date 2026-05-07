// @ts-nocheck
// app/api/integrations/fortnox/route.ts
//
// FORTNOX OAUTH 2.0 INTEGRATION — three routes in one file:
//
//   GET  /api/integrations/fortnox/connect  → redirects user to Fortnox login
//   GET  /api/integrations/fortnox/callback → exchanges code for tokens
//   POST /api/integrations/fortnox/sync     → pulls latest invoices from Fortnox
//   POST /api/integrations/fortnox/refresh  → refreshes expired access token
//
// BEFORE THIS WORKS you need:
//   1. Apply for a Fortnox developer account at developer.fortnox.se (allow 2-4 weeks)
//   2. Create an app — you get a Client ID and Client Secret
//   3. Add these to .env.local:
//      FORTNOX_CLIENT_ID=your_client_id
//      FORTNOX_CLIENT_SECRET=your_client_secret
//
// IMPORTANT: You create ONE app for all your customers.
//   Each customer authorises *their* Fortnox account to connect to *your* app.
//   You store their access_token per-org, encrypted in the integrations table.

import { NextRequest, NextResponse }  from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { encrypt, decrypt }           from '@/lib/integrations/encryption'
import { rateLimit }                  from '@/lib/middleware/rate-limit'
import { verifyOauthConnectToken }    from '@/lib/admin/oauth-link'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { createHmac, timingSafeEqual } from 'crypto'

// HMAC-sign the OAuth state so Fortnox can't be used to bind an attacker's
// Fortnox account to a victim's org. Signed with ADMIN_SECRET — same trust
// boundary as the rest of the admin surface.
function signState(payload: { orgId: string; businessId: string; nonce: string }): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const sig  = createHmac('sha256', process.env.ADMIN_SECRET || '').update(body).digest('base64')
  return `${body}.${sig}`
}
function verifyState(state: string): { orgId: string; businessId: string; nonce: string } | null {
  try {
    const [body, sig] = state.split('.')
    if (!body || !sig) return null
    const expected = createHmac('sha256', process.env.ADMIN_SECRET || '').update(body).digest('base64')
    const a = Buffer.from(expected, 'utf8'), b = Buffer.from(sig, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    return JSON.parse(Buffer.from(body, 'base64').toString('utf8'))
  } catch { return null }
}

// Fortnox API base URL
const FORTNOX_API     = 'https://api.fortnox.se/3'
const FORTNOX_AUTH    = 'https://apps.fortnox.se/oauth-v1/auth'
const FORTNOX_TOKEN   = 'https://apps.fortnox.se/oauth-v1/token'

// What data we ask permission to read from the customer's Fortnox account.
// Expanded 2026-05-07 (Fortnox-OAuth-Scope-Expansion-Prompt) ahead of Phase 2
// of the API backfill plan — the original 5 stay first, the new 5 follow.
// Fortnox treats the list as a set so order is for diff-readability only.
const FORTNOX_SCOPES  = [
  'bookkeeping',        // vouchers + general ledger entries — core financial data
  'invoice',            // sales invoices (revenue)
  'supplierinvoice',    // supplier invoices (AP analytics, costs)
  'salary',             // salary transactions — for Lön activation later
  'companyinformation', // basic company info, fiscal periods
  'costcenter',         // cost-center / department dimensions on transactions — feeds dept_metrics
  'customer',           // customer master records — for AR analytics, customer name lookups
  'supplier',           // supplier master records — for supplier price-creep analytics
  'timereport',         // attendance + scheduling time — pairs with `salary` for full Lön
  'article',            // article master data — for future item-level analysis
].join(' ')

// ── CONNECT: start the OAuth flow ────────────────────────────────
// Redirect the user to Fortnox's login page.
// Fortnox will ask them "Do you want to connect [Your App Name] to your account?"
// On approval, Fortnox redirects back to our callback URL with a code.

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action')

  if (action === 'connect') {
    const clientId = process.env.FORTNOX_CLIENT_ID
    const appUrl   = process.env.NEXT_PUBLIC_APP_URL

    if (!clientId) {
      return NextResponse.json({
        error: 'Fortnox integration not configured. Add FORTNOX_CLIENT_ID to environment variables.',
      }, { status: 500 })
    }

    // Two paths to authorise the caller:
    //   (A) Customer is logged in → use their Supabase session (self-service).
    //   (B) Signed admin-issued token → concierge flow where admin sends the
    //       customer a one-time link. The customer never logs into our app;
    //       they only authorise at Fortnox. Token is HMAC-SHA256 with ADMIN_SECRET.
    let orgId: string
    let businessId: string

    const token = searchParams.get('token')
    if (token) {
      const payload = verifyOauthConnectToken(token)
      if (!payload || payload.provider !== 'fortnox') {
        return NextResponse.json({ error: 'Invalid or expired connect link' }, { status: 401 })
      }
      orgId      = payload.orgId
      businessId = payload.businessId ?? ''
    } else {
      const auth = await getRequestAuth(req)
      if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
      orgId      = auth.orgId
      businessId = searchParams.get('business_id') ?? ''
    }

    // State is HMAC-signed so the callback can verify it originated from us.
    // Nonce makes replay attempts detectable if we ever cache recent states.
    const nonce = Math.random().toString(36).slice(2, 14)
    const state = signState({ orgId, businessId, nonce })
    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  `${appUrl}/api/integrations/fortnox?action=callback`,
      scope:         FORTNOX_SCOPES,
      response_type: 'code',
      state,
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

// ── CALLBACK: exchange code for tokens ───────────────────────────
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

  // Verify the HMAC-signed state. If the signature is wrong or the payload
  // is malformed, the callback is rejected — this is the CSRF gate.
  const verified = verifyState(state)
  if (!verified) {
    console.error('Fortnox OAuth callback: invalid state signature')
    return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_invalid_state`)
  }
  const orgId      = verified.orgId
  const businessId = verified.businessId ?? ''
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
      business_id:     businessId || null,
      provider:        'fortnox',
      status:          'connected',
      credentials_enc: encrypt(credentialsToStore),
      token_expires_at:expiresAt,
      last_sync_at:    null,
      last_error:      null,
      updated_at:      new Date().toISOString(),
    }, {
      onConflict: 'business_id,provider',
    })

  if (dbError) {
    console.error('Failed to save Fortnox credentials:', dbError)
    return NextResponse.redirect(`${appUrl}/integrations?error=fortnox_save_failed`)
  }

  await recordAdminAction(supabase, {
    action:     ADMIN_ACTIONS.INTEGRATION_ADD,
    orgId,
    targetType: 'integration',
    payload:    { provider: 'fortnox', business_id: businessId || null, via: 'oauth_callback' },
    actor:      'oauth_callback',
    req,
  })

  // Trigger initial sync in background (don't wait for it)
  syncFortnoxInBackground(orgId, access_token).catch(console.error)

  // Redirect back to the integrations page with success
  return NextResponse.redirect(`${appUrl}/integrations?connected=fortnox`)
}

// ── SYNC: pull data from Fortnox ──────────────────────────────────
// Fetches supplier invoices (costs) and sales invoices (revenue)
// for the current and previous month, then updates tracker_data.

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // max 20 requests per user per hour
  const limit = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 20 })
  if (!limit.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { action } = await req.json().catch(() => ({ action: 'sync' }))

  if (action === 'refresh') return refreshToken(auth.orgId)

  return syncFortnox(auth.orgId)
}

async function syncFortnoxInBackground(orgId: string, accessToken: string) {
  await syncFortnox(orgId)
}

async function syncFortnox(orgId: string): Promise<Response> {
  const supabase = createAdminClient()

  // Get decrypted credentials. Business_id is required so we know which
  // business the Fortnox data belongs to (customer may have multiple).
  const { data: integration } = await supabase
    .from('integrations')
    .select('credentials_enc, token_expires_at, business_id')
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

  // Last day of current month — avoids `2026-04-31` style invalid dates
  // by stepping into month N+1 at day 0, which JS resolves to last-day-of-N.
  const lastDay = new Date(year, month, 0).getDate()
  const mm      = String(month).padStart(2, '0')
  const fromDate = `${year}-${mm}-01`
  const toDate   = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`

  try {
    // Fetch supplier invoices (costs) and sales invoices (revenue) in parallel.
    const [supplierRes, salesRes] = await Promise.all([
      fortnoxGet(`/supplierinvoices?fromdate=${fromDate}&todate=${toDate}`),
      fortnoxGet(`/invoices?fromdate=${fromDate}&todate=${toDate}`),
    ])

    const supplierInvoices: any[] = supplierRes.SupplierInvoices ?? []
    const salesInvoices:    any[] = salesRes.Invoices ?? []

    // Revenue = sum of sales-invoice totals. Fortnox exposes `Total` in SEK
    // (ex-moms on most account setups; the customer's chart of accounts determines
    // whether Total is gross or net — we document this caveat in the Fortnox doc).
    // We skip cancelled invoices (Fortnox `Cancelled: true`).
    const revenue = salesInvoices
      .filter((inv: any) => !inv.Cancelled)
      .reduce((sum: number, inv: any) => sum + (parseFloat(inv.Total ?? '0') || 0), 0)

    // Aggregate supplier invoices into cost categories
    // Priority order:
    //   1. Fortnox account code (most accurate — Martin & Servera line items split correctly)
    //   2. Supplier name mapping rules (from supplier_mappings table)
    //   3. Keyword fallback

    // Load supplier mapping rules for this org
    const { data: supplierRules } = await supabase
      .from('supplier_mappings')
      .select('vendor_contains, category, category_label, priority')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    const rules = supplierRules ?? []

    let staff_cost = 0, food_cost = 0, rent_cost = 0, other_cost = 0, alcohol_cost = 0

    // BAS account code → category mapping
    const ACCOUNT_CATS: Record<string, string> = {
      '4010': 'food', '4011': 'alcohol', '4000': 'food', '4012': 'food',
      '4400': 'food', '4500': 'food', '4535': 'food', '4990': 'food',
      '5010': 'rent', '5011': 'rent', '5012': 'rent', '5090': 'rent',
      '5060': 'other', '5160': 'other', '5460': 'other', '5480': 'other',
      '5500': 'other', '5410': 'other', '5170': 'other',
      '6800': 'staff',
      '5900': 'other', '5910': 'other', '5990': 'other', '6050': 'other',
      '6040': 'other', '6200': 'other', '6212': 'other', '6310': 'other',
      '6370': 'other', '6530': 'other', '6540': 'other', '6550': 'other',
      '6570': 'other', '6590': 'other', '6950': 'other',
    }

    for (const inv of supplierInvoices) {
      const amount      = parseFloat(inv.Total ?? 0)
      const accountCode = (inv.AccountNumber ?? inv.Account ?? '').toString().trim()
      const supplier    = (inv.SupplierName ?? '').toLowerCase()

      let category = ''

      // 1. Account code match (most accurate)
      if (accountCode && ACCOUNT_CATS[accountCode]) {
        category = ACCOUNT_CATS[accountCode]
      }

      // 2. Supplier name mapping rules
      if (!category && rules.length > 0) {
        const match = rules.find(r => supplier.includes(r.vendor_contains.toLowerCase()))
        if (match) {
          if (match.category === 'alcohol')       category = 'alcohol'
          else if (match.category === 'food_beverage') category = 'food'
          else if (match.category === 'staff')    category = 'staff'
          else if (match.category === 'rent')     category = 'rent'
          else                                    category = 'other'
        }
      }

      // 3. Keyword fallback
      if (!category) {
        if (/lön|personal|bemanning|arbetsgivar/.test(supplier)) category = 'staff'
        else if (/alkohol|sprit|vin|öl|systembolaget/.test(supplier)) category = 'alcohol'
        else if (/menigo|martin.*servera|mat|livsmedel|råvar/.test(supplier)) category = 'food'
        else if (/hyra|lokal|fastighet/.test(supplier)) category = 'rent'
        else category = 'other'
      }

      if      (category === 'staff')   staff_cost   += amount
      else if (category === 'food')    food_cost    += amount
      else if (category === 'alcohol') food_cost    += amount  // alcohol goes into food_cost for P&L
      else if (category === 'rent')    rent_cost    += amount
      else                             other_cost   += amount
    }

    const total_cost  = staff_cost + food_cost + rent_cost + other_cost
    const net_profit  = revenue - total_cost
    const margin_pct  = revenue > 0 ? Math.round((net_profit / revenue) * 1000) / 10 : 0
    const gross_profit= revenue - food_cost

    // Use business_id from the integration row (set during OAuth connect)
    // Falls back to first active business if not set (legacy behaviour)
    let businessId = integration.business_id ?? null

    if (!businessId) {
      const { data: businesses } = await supabase
        .from('businesses')
        .select('id')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .limit(1)
      businessId = businesses?.[0]?.id ?? null
    }

    if (!businessId) {
      return NextResponse.json({ error: 'No active business found for this org' }, { status: 404 })
    }

    // Upsert tracker_data — update if exists, insert if not
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

// ── TOKEN REFRESH ─────────────────────────────────────────────────
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
    return NextResponse.json({ error: 'No refresh token available — please reconnect Fortnox' }, { status: 400 })
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
      .update({ status: 'error', last_error: 'Token refresh failed — please reconnect Fortnox' })
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

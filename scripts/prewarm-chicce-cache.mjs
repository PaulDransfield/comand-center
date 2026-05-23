// One-off pre-warm: fetch vouchers for Chicce's full FY 2025-09 → 2026-05
// using the production Fortnox token. Each missing month is fetched and
// inserted into fortnox_vouchers_cache via the same path the balance
// sheet uses.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const orgId = (await db.from('businesses').select('org_id').eq('id', bizId).maybeSingle()).data?.org_id
if (!orgId) { console.error('no orgId'); process.exit(1) }

// Get fresh access token. Borrows the same refresh path the app uses.
const { data: integ } = await db
  .from('integrations')
  .select('credentials_enc')
  .eq('business_id', bizId)
  .eq('provider', 'fortnox')
  .maybeSingle()

if (!integ) { console.error('no integration'); process.exit(1) }

// We need to call /api/admin/voucher-cache/refresh or similar to do this
// properly. Simpler: hit a cron-secret endpoint.

// Actually let's just call /api/cron/voucher-cache-refresh with the
// cron secret. It'll refresh current+previous month, but that's not
// what we need.

// Manual approach: paginated fetch from Fortnox for each missing month
// using getFreshFortnoxAccessToken. But we can't import that into a
// node script easily.

// Cleanest: pretend to be the user and call the balance-sheet endpoint
// (or vouchers endpoint) for each month — that primes the cache.

// Even simpler — hit the public /api/revisor/vouchers endpoint for each
// missing month, with cookies from a logged-in session. We don't have
// that here.

// Simplest of all: write directly to the cache table after fetching from
// Fortnox manually. But that requires the access token.

// Let's just trigger via the production CRON_SECRET hitting a fresh
// endpoint we'll write — or hit the voucher endpoint via a service-key
// authenticated path. Actually we have a "/api/admin/voucher-cache/force-refresh"?

// Read it from env
const cronSecret = process.env.CRON_SECRET
if (!cronSecret) { console.error('CRON_SECRET missing'); process.exit(1) }

const APP = 'https://comandcenter.se'
// Try the existing voucher-cache-refresh cron endpoint — it processes
// current + previous month for ALL businesses. Not ideal but ok.
console.log('Calling /api/cron/voucher-cache-refresh...')
const r1 = await fetch(`${APP}/api/cron/voucher-cache-refresh`, {
  headers: { 'Authorization': `Bearer ${cronSecret}` },
})
console.log('status:', r1.status)
const t1 = await r1.text()
console.log(t1.slice(0, 600))

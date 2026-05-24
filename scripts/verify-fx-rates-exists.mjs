// scripts/verify-fx-rates-exists.mjs — direct fetch against
// information_schema via PostgREST rpc workaround. If the table really
// doesn't exist in the DB, this confirms M088 needs re-applying.
//
// Run: node --env-file=.env.production.local scripts/verify-fx-rates-exists.mjs

const url    = process.env.NEXT_PUBLIC_SUPABASE_URL
const apikey = process.env.SUPABASE_SERVICE_ROLE_KEY

// Try a raw HEAD against the table — PostgREST returns 404 with a
// different body depending on whether the table EXISTS but the cache
// is stale vs DOES NOT EXIST at all.
const res = await fetch(`${url}/rest/v1/fx_rates?select=count&limit=0`, {
  method: 'HEAD',
  headers: {
    'apikey':        apikey,
    'Authorization': `Bearer ${apikey}`,
    'Prefer':        'count=exact',
  },
})
console.log('HEAD /rest/v1/fx_rates:', res.status, res.statusText)
console.log('Headers:', Object.fromEntries(res.headers))

// Also try GET so we see the body
const res2 = await fetch(`${url}/rest/v1/fx_rates?select=*&limit=1`, {
  headers: {
    'apikey':        apikey,
    'Authorization': `Bearer ${apikey}`,
  },
})
console.log('\nGET /rest/v1/fx_rates:', res2.status)
console.log(await res2.text())

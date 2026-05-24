// scripts/verify-session-tables.mjs
// Quick sanity check that every table this session created is visible
// to PostgREST. If any returns PGRST205 the cache is stale — paste
// NOTIFY pgrst, 'reload schema'; in Supabase SQL editor.

const url    = process.env.NEXT_PUBLIC_SUPABASE_URL
const apikey = process.env.SUPABASE_SERVICE_ROLE_KEY

const tables = [
  'fx_rates',                  // M088
  'stock_locations',           // M091
  'stock_counts',              // M092
  'stock_count_lines',         // M092
  'waste_log',                 // M093
]

const overrideCols = ['price_override', 'source_recipe_id', 'pack_size']  // M087/M089/M090 added these to products

console.log('Tables:')
for (const t of tables) {
  const r = await fetch(`${url}/rest/v1/${t}?select=count&limit=0`, {
    method: 'HEAD',
    headers: {
      'apikey':        apikey,
      'Authorization': `Bearer ${apikey}`,
      'Prefer':        'count=exact',
    },
  })
  const tag = r.ok ? '✓' : '✗'
  console.log(`  ${tag} ${t.padEnd(28)} ${r.status} ${r.statusText}`)
}

console.log('\nproducts columns (recent ALTERs):')
const r = await fetch(`${url}/rest/v1/products?select=${overrideCols.join(',')}&limit=1`, {
  headers: { 'apikey': apikey, 'Authorization': `Bearer ${apikey}` },
})
const txt = await r.text()
if (r.ok) console.log('  ✓ all columns visible')
else      console.log('  ✗', r.status, txt.slice(0, 200))

// scripts/probe-supabase.mjs
// One-shot connectivity probe — bypasses supabase-js, hits the REST endpoint
// with bare fetch() so any network failure surfaces with its real cause.
// Run: npx -y dotenv-cli -e .env.local -- node scripts/probe-supabase.mjs

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

console.log('NEXT_PUBLIC_SUPABASE_URL:', JSON.stringify(url))
console.log('SUPABASE_SERVICE_ROLE_KEY length:', key?.length ?? 0)
console.log('SUPABASE_SERVICE_ROLE_KEY first 20:', key?.slice(0, 20))
console.log('')

if (!url || !key) {
  console.log('Missing env vars — aborting.')
  process.exit(1)
}

const target = url + '/rest/v1/integrations?limit=1'
console.log('Hitting:', target)

try {
  const r = await fetch(target, {
    headers: {
      apikey:        key,
      Authorization: 'Bearer ' + key,
    },
  })
  console.log('status:', r.status)
  console.log('body:', (await r.text()).slice(0, 200))
} catch (e) {
  console.log('FAIL:', e.message, e.code ?? '')
  console.log('cause:', e.cause?.message ?? '(none)', e.cause?.code ?? '')
  if (e.cause?.errors) {
    for (const sub of e.cause.errors) {
      console.log('  sub:', sub?.message ?? sub, sub?.code ?? '')
    }
  }
  console.log('cause stack:', e.cause?.stack?.split('\n').slice(0, 4).join(' | '))
}

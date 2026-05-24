// scripts/trigger-fx-rates-update.mjs
//
// Kick /api/cron/fx-rates-update so today's ECB rates land immediately
// rather than waiting for the 17:00 UTC daily cron.
//
// Sends both Bearer CRON_SECRET AND x-admin-secret (checkAdminSecret).
// Either matches → 200. If both fail (local env doesn't match Vercel)
// the response body shows which paths were tried so we can debug.
//
// Run: node --env-file=.env.production.local scripts/trigger-fx-rates-update.mjs

const base   = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
const cron   = process.env.CRON_SECRET
const admin  = process.env.ADMIN_SECRET

if (!cron && !admin) {
  console.error('Neither CRON_SECRET nor ADMIN_SECRET in env')
  process.exit(1)
}

const url = `${base}/api/cron/fx-rates-update`
const headers = { 'Content-Type': 'application/json' }
if (cron)  headers['Authorization']    = `Bearer ${cron}`
if (admin) headers['x-admin-secret']   = admin

console.log(`POST ${url}`)
console.log(`Headers: ${Object.keys(headers).join(', ')}`)

const res = await fetch(url, { method: 'POST', headers })
const text = await res.text()
console.log(`\nHTTP ${res.status}`)
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2))
} catch {
  console.log(text.slice(0, 2000))
}

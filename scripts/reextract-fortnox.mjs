#!/usr/bin/env node
// Bulk re-extract every Fortnox PDF stored in Supabase for an org or
// specific business. Hits POST /api/fortnox/reextract-all on production
// (or local dev — set BASE_URL).
//
// Usage:
//   node scripts/reextract-fortnox.mjs                       # whole org
//   node scripts/reextract-fortnox.mjs <business_id>          # one biz
//   BASE_URL=http://localhost:3000 node scripts/reextract-fortnox.mjs
//
// Requires: a session cookie for an authenticated owner of the org. Easiest
// way to grab one: open the live app in a browser, DevTools → Application →
// Cookies, copy the `sb-llzmixkrysduztsvmfzi-auth-token` value (or similar)
// into SESSION_COOKIE env var.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')] })
    )
  } catch { return {} }
}

const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local'), ...process.env }
const BASE = env.BASE_URL ?? 'https://comandcenter.se'
const COOKIE = env.SESSION_COOKIE ?? env.SUPABASE_AUTH_COOKIE
const businessId = process.argv[2] || null

if (!COOKIE) {
  console.error('ERROR: SESSION_COOKIE env var required (or SUPABASE_AUTH_COOKIE).')
  console.error('Grab it from the browser DevTools → Cookies after logging in.')
  process.exit(1)
}

console.log(`POSTing /api/fortnox/reextract-all to ${BASE}…`)
console.log(`  business_id = ${businessId ?? '(all in org)'}`)

const r = await fetch(`${BASE}/api/fortnox/reextract-all`, {
  method:  'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie':       COOKIE,
  },
  body: JSON.stringify(businessId ? { business_id: businessId } : {}),
})

const body = await r.json().catch(() => ({}))
if (!r.ok) {
  console.error(`HTTP ${r.status}:`, body.error ?? body)
  process.exit(2)
}

console.log('OK:', body.message)
console.log(`Queued: ${body.queued} PDFs, ETA ~${Math.ceil((body.eta_seconds ?? 0) / 60)} minutes.`)
console.log('')
console.log('Watch progress: open /overheads — each row will flip to "extracting"')
console.log('then back to "extracted" with a "Review & apply" button.')

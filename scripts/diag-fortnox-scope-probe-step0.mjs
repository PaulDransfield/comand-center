#!/usr/bin/env node
// scripts/diag-fortnox-scope-probe-step0.mjs
//
// Phase 2 kickoff — Step 0 ONLY (phase-2-fortnox-scope-probe-prompt.md).
//
// Goal: confirm token state + scope coverage for Chicce + Vero Fortnox
// integrations. NO data fetched beyond a 1-row /suppliers and /articles
// probe per business — enough to see HTTP 200 vs 401 vs 403 and read
// the actual `Scope` from the credentials_enc payload.
//
// HARD RULES (from the prompt):
//   - GET only. No POST/PUT/DELETE to Fortnox.
//   - No DB writes. No persistent tables.
//   - Never print secrets — tokens, client_secret, credentials_enc raw.
//   - Sample, don't sync.
//   - Run off-peak (now, ~20:40 UTC, well clear of the 06:10 daily sync).
//
// What this script does NOT do:
//   - Refresh tokens (needs FORTNOX_CLIENT_ID/SECRET; not in local env)
//   - Fetch sample pages (that's Part A / Part B in the next pass)
//   - Persist anything anywhere
//
// What it DOES do:
//   - Read integrations metadata for Chicce + Vero (no creds values)
//   - Decrypt credentials_enc locally to read scope + expires_at
//   - If token still valid: GET /suppliers?limit=1 + /articles?limit=1
//     to confirm the scopes actually return 200
//   - Report a per-business Step-0 verdict

import { readFileSync }                  from 'node:fs'
import { createDecipheriv }              from 'node:crypto'

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
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const URL    = env.NEXT_PUBLIC_SUPABASE_URL
const KEY    = env.SUPABASE_SERVICE_ROLE_KEY
const ENCKEY = env.CREDENTIAL_ENCRYPTION_KEY
if (!URL || !KEY)    { console.error('Missing supabase env'); process.exit(1) }
if (!ENCKEY)         { console.error('Missing CREDENTIAL_ENCRYPTION_KEY (needed to read token scope locally)'); process.exit(1) }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` }

// Mirror of lib/integrations/encryption.ts::decrypt — copied verbatim
// to avoid importing TS from a .mjs script. Pure node:crypto.
function decryptCred(encryptedBase64) {
  if (!encryptedBase64) return null
  const key    = Buffer.from(ENCKEY, 'hex')
  const packed = Buffer.from(encryptedBase64, 'base64')
  const iv         = packed.subarray(0, 12)
  const authTag    = packed.subarray(packed.length - 16)
  const ciphertext = packed.subarray(12, packed.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

const VERO   = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

async function q(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H })
  if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}: ${await r.text().catch(() => '')}`)
  return r.json()
}

const section = (title) => console.log(`\n${'═'.repeat(74)}\n  ${title}\n${'═'.repeat(74)}`)

// ───────────────────────────────────────────────────────────────────────
// 1. Plumbing recon — confirm we know where the Fortnox client lives
// ───────────────────────────────────────────────────────────────────────

section('1. Fortnox plumbing — files we already have')
console.log('  lib/fortnox/api/auth.ts        — getFreshFortnoxAccessToken, refresh lock (M096)')
console.log('  lib/fortnox/api/fetch.ts       — fortnoxFetch wrapper with 2-in-flight semaphore')
console.log('  lib/fortnox/api/vouchers.ts    — voucher fetcher (Phase 2 backfill stack)')
console.log('  app/api/integrations/fortnox/route.ts — OAuth flow + FORTNOX_SCOPES constant')
console.log('  \n  FORTNOX_SCOPES granted (from app/api/integrations/fortnox/route.ts:69-88):')
console.log('    bookkeeping, invoice, supplierinvoice, salary, companyinformation,')
console.log('    costcenter, customer, supplier, timereporting, article, archive, inbox, connectfile')
console.log('  \n  Per CLAUDE.md memory: scope list expanded 2026-05-07 to add the')
console.log('  five new ones (costcenter, customer, supplier, timereporting, article,')
console.log('  archive, inbox, connectfile). Stored tokens from BEFORE that date may')
console.log('  lack supplier+article — that is what we are verifying now.')

// ───────────────────────────────────────────────────────────────────────
// 2. Read integration metadata for Chicce + Vero (NO secrets printed)
// ───────────────────────────────────────────────────────────────────────

section('2. Stored Fortnox integration state (Chicce + Vero)')

const integrations = await q(
  `integrations?select=id,business_id,status,credentials_enc,token_expires_at,last_sync_at,created_at,updated_at` +
  `&business_id=in.(${VERO},${CHICCE})&provider=eq.fortnox`
)
console.log(`  Found ${integrations.length} Fortnox integration row(s).`)

const now = Date.now()
const SCOPE_ADDED_DATE = '2026-05-07'
const findings = []

for (const integ of integrations) {
  const who = integ.business_id === VERO ? 'Vero Italiano' : integ.business_id === CHICCE ? 'Chicce Slotsgatan' : '(other)'
  console.log(`\n  ── ${who} (${integ.business_id}) ──`)
  console.log(`     status:           ${integ.status}`)
  console.log(`     created_at:       ${integ.created_at}`)
  console.log(`     last_sync_at:     ${integ.last_sync_at ?? '(never)'}`)
  console.log(`     token_expires_at: ${integ.token_expires_at ?? '(unknown)'}`)

  // Decode credentials locally — read scope + expires_at + access_token
  // length (proves we can decrypt; never prints the token itself).
  let creds = null
  try {
    creds = JSON.parse(decryptCred(integ.credentials_enc) ?? '{}')
  } catch (err) {
    console.log(`     decrypt:          FAILED (${err.message})`)
    findings.push({ who, status: 'decrypt_failed', error: err.message })
    continue
  }

  const accessLen  = creds.access_token  ? creds.access_token.length  : 0
  const refreshLen = creds.refresh_token ? creds.refresh_token.length : 0
  const expiresAt  = typeof creds.expires_at === 'number' ? creds.expires_at : (creds.expires_at ? Date.parse(creds.expires_at) : null)
  const minsToExp  = expiresAt ? Math.round((expiresAt - now) / 60_000) : null
  const isValid    = expiresAt != null && expiresAt > now

  console.log(`     access_token:     length=${accessLen} (value NOT printed)`)
  console.log(`     refresh_token:    length=${refreshLen} (value NOT printed)`)
  console.log(`     expires_at:       ${expiresAt ? new Date(expiresAt).toISOString() : '(unknown)'}  (${minsToExp != null ? (minsToExp >= 0 ? `+${minsToExp}min from now` : `${minsToExp}min ago — EXPIRED`) : 'unknown'})`)

  // ── THE critical question: what scope does the STORED token actually carry?
  const scopeStr   = String(creds.scope ?? '')
  const scopeList  = scopeStr.split(/\s+/).filter(Boolean)
  const hasSupplier = scopeList.includes('supplier')
  const hasArticle  = scopeList.includes('article')
  console.log(`     scope (${scopeList.length} entries):`)
  console.log(`       carries 'supplier'? ${hasSupplier ? 'YES' : 'NO — re-auth required'}`)
  console.log(`       carries 'article'?  ${hasArticle  ? 'YES' : 'NO — re-auth required'}`)
  // Print the full granted scope set (it's not secret — just lists granted permissions)
  console.log(`       full set: ${scopeList.join(', ') || '(empty)'}`)

  // Connection-vs-scope-addition timing
  const connectedDate = integ.created_at.slice(0, 10)
  const connectedBeforeScopeAdded = connectedDate < SCOPE_ADDED_DATE
  console.log(`     connected ${connectedDate} — ${connectedBeforeScopeAdded ? `BEFORE ${SCOPE_ADDED_DATE} scope expansion (token may lack new scopes unless re-OAuthed since)` : `AFTER scope expansion (should carry full set)`}`)

  findings.push({
    who, business_id: integ.business_id,
    status: integ.status,
    token_valid: isValid,
    minutes_to_expiry: minsToExp,
    has_refresh_token: refreshLen > 0,
    has_supplier_scope: hasSupplier,
    has_article_scope: hasArticle,
    connected_before_scope_expansion: connectedBeforeScopeAdded,
    access_token: isValid ? creds.access_token : null,  // kept in memory only for the probe — never printed
  })
}

// ───────────────────────────────────────────────────────────────────────
// 3. Live probe — tiny GET /suppliers + /articles to verify scope WORKS
// ───────────────────────────────────────────────────────────────────────
//
// Only attempted when token is currently valid. ?limit=1 keeps the
// payload minimal and stays well within rate limits. We just check
// the HTTP status — 200 confirms scope, 401 means token expired,
// 403 means scope missing.

section('3. Live scope probe — GET /suppliers?limit=1 and /articles?limit=1')

const FORTNOX_API = 'https://api.fortnox.se/3'
const noFresh = []

for (const f of findings) {
  if (f.status === 'decrypt_failed') continue
  if (!f.access_token) {
    console.log(`\n  ── ${f.who}: SKIP (no valid access_token in memory)`)
    noFresh.push(f.who)
    continue
  }

  console.log(`\n  ── ${f.who} ──`)
  for (const endpoint of ['suppliers', 'articles']) {
    const t0 = Date.now()
    const r = await fetch(`${FORTNOX_API}/${endpoint}?limit=1`, {
      headers: {
        Authorization: `Bearer ${f.access_token}`,
        'Content-Type': 'application/json',
        Accept:         'application/json',
      },
    })
    const elapsed = Date.now() - t0
    const status = r.status
    let summary = ''
    if (status === 200) {
      const j = await r.json().catch(() => null)
      const meta = j?.MetaInformation ?? {}
      const total = meta['@TotalResources'] ?? meta.TotalResources ?? '?'
      const pageCount = meta['@TotalPages'] ?? meta.TotalPages ?? '?'
      // Verify a row came back (don't print row content beyond key count)
      const arrayKey = endpoint === 'suppliers' ? 'Suppliers' : 'Articles'
      const rows = j?.[arrayKey] ?? []
      summary = `OK — total=${total}, total_pages=${pageCount}, sample_rows=${rows.length}, sample_keys=[${Object.keys(rows[0] ?? {}).join(',')}]`
    } else if (status === 401) {
      summary = 'UNAUTHORIZED — token rejected (despite expires_at being in future?)'
    } else if (status === 403) {
      summary = 'FORBIDDEN — scope likely missing'
    } else {
      summary = `HTTP ${status}: ${(await r.text().catch(() => '')).slice(0, 120)}`
    }
    console.log(`     /${endpoint.padEnd(10)}  ${status}  (${elapsed}ms)  ${summary}`)

    // Persist the probe result back on the finding for the summary table
    if (endpoint === 'suppliers') f.probe_suppliers_status = status
    else                          f.probe_articles_status  = status
  }
}

// ───────────────────────────────────────────────────────────────────────
// 4. Step 0 verdict table
// ───────────────────────────────────────────────────────────────────────

section('4. Step 0 verdict — per-business readiness')

console.log(`\n  business           token_valid?  has_supplier_scope?  has_article_scope?  /suppliers  /articles  verdict`)
console.log(`  ${'─'.repeat(28)}  ${'─'.repeat(12)}  ${'─'.repeat(19)}  ${'─'.repeat(18)}  ${'─'.repeat(10)}  ${'─'.repeat(9)}  ${'─'.repeat(36)}`)
for (const f of findings) {
  if (f.status === 'decrypt_failed') {
    console.log(`  ${f.who.padEnd(28)}  DECRYPT FAILED — ${f.error}`)
    continue
  }
  const verdict =
    f.probe_suppliers_status === 200 && f.probe_articles_status === 200 ? 'READY for Part A + Part B' :
    f.probe_suppliers_status === 403 || f.probe_articles_status === 403 ? 'RE-AUTH required (scope missing in stored token)' :
    f.probe_suppliers_status === 401 || f.probe_articles_status === 401 ? 'TOKEN expired — refresh needed' :
    !f.token_valid ? 'TOKEN expired — refresh needed (no client_id/secret locally to refresh)' :
    'mixed (see probe lines above)'
  console.log(
    `  ${f.who.padEnd(28)}  ${(f.token_valid ? 'yes' : 'NO').padEnd(12)}  ` +
    `${(f.has_supplier_scope ? 'YES' : 'no').padEnd(19)}  ${(f.has_article_scope ? 'YES' : 'no').padEnd(18)}  ` +
    `${String(f.probe_suppliers_status ?? '-').padEnd(10)}  ${String(f.probe_articles_status ?? '-').padEnd(9)}  ` +
    verdict
  )
}

console.log('\nDone. Read-only — no rows changed, no Fortnox writes, no secrets printed.\n')

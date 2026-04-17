// @ts-nocheck
// app/api/admin/probe-inzii/route.ts
//
// Careful single-server probe for Inzii/Swess POS.
// api.swess.se is confirmed real (Varnish responds with 429 when hammered).
// This version fires requests one at a time with 2s delays so we don't trip
// the rate limiter. Tries most-likely paths + auth combos first, stops as
// soon as we get a non-429 response that has data.
//
// POST /api/admin/probe-inzii
//   Authorization: Bearer <ADMIN_SECRET>
//   { integration_id: "uuid" }  ← specific integration
//   OR { org_id: "uuid" }       ← first inzii integration found

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'
import Anthropic                     from '@anthropic-ai/sdk'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Confirmed: api.swess.se is the real server (Varnish cache confirmed)
// Try paths in order of likelihood. Swess is a Swedish POS, likely REST + JSON.
const CANDIDATES = [
  // Most likely: versioned API paths with api_key query param
  { path: '/api/v1/sales',         auth: 'api_key' },
  { path: '/api/v1/daily',         auth: 'api_key' },
  { path: '/api/v1/daily-summary', auth: 'api_key' },
  { path: '/api/v1/report',        auth: 'api_key' },
  { path: '/api/v1/z-report',      auth: 'api_key' },
  { path: '/api/v1/z-reports',     auth: 'api_key' },
  { path: '/api/v1/receipts',      auth: 'api_key' },
  { path: '/api/v1/transactions',  auth: 'api_key' },
  { path: '/api/v1/orders',        auth: 'api_key' },
  { path: '/api/v1/revenue',       auth: 'api_key' },
  // Unversioned paths
  { path: '/sales',                auth: 'api_key' },
  { path: '/daily',                auth: 'api_key' },
  { path: '/daily-summary',        auth: 'api_key' },
  { path: '/report',               auth: 'api_key' },
  { path: '/z-report',             auth: 'api_key' },
  { path: '/receipts',             auth: 'api_key' },
  { path: '/transactions',         auth: 'api_key' },
  // Try bearer token on most likely paths
  { path: '/api/v1/sales',         auth: 'bearer' },
  { path: '/api/v1/daily',         auth: 'bearer' },
  { path: '/api/v1/report',        auth: 'bearer' },
  { path: '/sales',                auth: 'bearer' },
  { path: '/daily',                auth: 'bearer' },
  // Try x-api-key header
  { path: '/api/v1/sales',         auth: 'x-api-key' },
  { path: '/api/v1/daily',         auth: 'x-api-key' },
  { path: '/api/v1/report',        auth: 'x-api-key' },
  // Try token query param (some Swess installs use ?token=)
  { path: '/api/v1/sales',         auth: 'token' },
  { path: '/api/v1/daily',         auth: 'token' },
  { path: '/sales',                auth: 'token' },
]

const BASE = 'https://api.swess.se'

function buildRequest(path: string, auth: string, apiKey: string, from: string, to: string) {
  const dateQuery = `from=${from}&to=${to}`
  const headers: Record<string, string> = { Accept: 'application/json' }

  switch (auth) {
    case 'api_key':
      return { url: `${BASE}${path}?api_key=${apiKey}&${dateQuery}`, headers }
    case 'bearer':
      headers.Authorization = `Bearer ${apiKey}`
      return { url: `${BASE}${path}?${dateQuery}`, headers }
    case 'x-api-key':
      headers['x-api-key'] = apiKey
      return { url: `${BASE}${path}?${dateQuery}`, headers }
    case 'token':
      return { url: `${BASE}${path}?token=${apiKey}&${dateQuery}`, headers }
    default:
      return { url: `${BASE}${path}?api_key=${apiKey}&${dateQuery}`, headers }
  }
}

function redact(url: string, apiKey: string) {
  return url.replace(apiKey, '***KEY***')
}

// ── Ask Claude to interpret results ──────────────────────────────────────────
async function askClaude(results: any[], department: string) {
  const interesting = results.filter(r => r.status !== 429 && r.status !== 0)

  if (interesting.length === 0) {
    // All 429 still — report what we know
    const has429 = results.some(r => r.status === 429)
    return {
      conclusion:          has429 ? 'rate_limited' : 'no_response',
      summary:             has429
        ? 'All requests returned 429 Too Many Requests. The server is still rate-limiting. Wait 5 minutes and try again, or the API key may need to be whitelisted for higher rate limits.'
        : 'All requests timed out. The server may be down.',
      working_url_pattern: null,
      working_auth_type:   null,
      base_url:            null,
      path:                null,
      revenue_field:       null,
      date_field:          null,
      covers_field:        null,
      next_step:           has429 ? 'Wait 5 minutes then retry, or contact Swess support for API documentation.' : 'Check server status.',
    }
  }

  const prompt = `
You are an API integration expert. I am probing a Swedish restaurant POS system (Swess/Inzii) at api.swess.se.
Here are ALL responses I got (non-timeout, non-429). Find the working endpoint that returns sales/revenue data.

Department: ${department}

Results:
${JSON.stringify(interesting, null, 2)}

Return JSON only — no markdown, no explanation outside JSON:
{
  "conclusion": "found" | "auth_issue" | "wrong_path" | "rate_limited" | "unknown",
  "summary": "one clear paragraph",
  "working_url_pattern": "full URL pattern with placeholders e.g. https://api.swess.se/api/v1/sales?api_key=KEY&from=FROM&to=TO — or null",
  "working_auth_type": "api_key | bearer | x-api-key | token — or null",
  "base_url": "https://api.swess.se — or null",
  "path": "/api/v1/sales — or null",
  "revenue_field": "field name containing net sales amount — or null",
  "date_field": "field name for the date — or null",
  "covers_field": "field name for guest count — or null",
  "sample_fields": ["all field names found in data if any"],
  "next_step": "what to do next if not found"
}
`

  try {
    const msg  = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = (msg.content[0] as any).text
    const json = text.match(/\{[\s\S]*\}/)
    return json ? JSON.parse(json[0]) : { conclusion: 'parse_error', summary: text }
  } catch (e: any) {
    return { conclusion: 'claude_error', summary: e.message }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader || authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body          = await req.json().catch(() => ({}))
  const integrationId = body.integration_id
  const orgId         = body.org_id
  const db            = createAdminClient()

  // Fetch the integration
  let query = db.from('integrations')
    .select('id, org_id, business_id, credentials_enc, provider, department, status')
    .eq('provider', 'inzii')
    .eq('status', 'connected')

  if (integrationId) query = query.eq('id', integrationId)
  else if (orgId)    query = query.eq('org_id', orgId)

  const { data: integ, error: integErr } = await query.limit(1).maybeSingle()

  if (integErr || !integ) {
    return NextResponse.json({ error: 'No connected Inzii integration found', detail: integErr?.message }, { status: 404 })
  }

  const apiKey     = decrypt(integ.credentials_enc)
  const department = integ.department ?? 'pos'

  if (!apiKey) {
    return NextResponse.json({ error: 'Could not decrypt credentials' }, { status: 500 })
  }

  const to   = new Date()
  const from = new Date(to.getTime() - 30 * 86400000)
  const fromStr = from.toISOString().slice(0, 10)
  const toStr   = to.toISOString().slice(0, 10)

  console.log(`Probing Inzii (careful mode) for dept: ${department} key: ${apiKey.slice(0,6)}…`)

  const results: any[] = []
  let foundResult: any = null

  for (const c of CANDIDATES) {
    const req2 = buildRequest(c.path, c.auth, apiKey, fromStr, toStr)

    let result: any
    try {
      const res         = await fetch(req2.url, { headers: req2.headers, signal: AbortSignal.timeout(10000) })
      const contentType = res.headers.get('content-type') ?? ''
      let   body: any   = null
      try {
        body = contentType.includes('json') ? await res.json() : await res.text()
      } catch { body = null }

      result = {
        url:         redact(req2.url, apiKey),
        auth:        c.auth,
        status:      res.status,
        contentType,
        body,
        hasData:     res.status === 200 && body !== null,
      }
    } catch (err: any) {
      result = { url: redact(req2.url, apiKey), auth: c.auth, status: 0, contentType: '', body: err.message, hasData: false }
    }

    results.push(result)
    console.log(`  ${result.status} ${result.url}`)

    // If we got actual data, stop immediately
    if (result.hasData) {
      foundResult = result
      break
    }

    // If we get a definitive auth error (not 429), note it but keep trying
    // If still 429, keep going with delay — different paths may have different rate limits
    // Always wait 2s between requests to stay under the rate limit
    await sleep(2000)
  }

  const analysis = await askClaude(results, department)

  // Save confirmed endpoint to api_discoveries_enhanced
  if (analysis.conclusion === 'found' && analysis.base_url) {
    try {
      await db.from('api_discoveries_enhanced').upsert({
        integration_id:          integ.id,
        org_id:                  integ.org_id,
        business_id:             integ.business_id,
        provider:                'inzii',
        provider_type:           'pos',
        analysis_result:         { probe_analysis: analysis, raw_results: results.filter(r => r.hasData) },
        discovered_at:           new Date().toISOString(),
        confidence_score:        90,
        data_type:               'revenue',
        unused_fields_count:     0,
        business_insights_count: 1,
      }, { onConflict: 'integration_id' })
    } catch (e: any) {
      console.warn('Could not save to api_discoveries_enhanced:', e.message)
    }
  }

  const summary = {
    total_probed: results.length,
    status_200:   results.filter(r => r.status === 200).length,
    status_401:   results.filter(r => r.status === 401).length,
    status_403:   results.filter(r => r.status === 403).length,
    status_404:   results.filter(r => r.status === 404).length,
    status_429:   results.filter(r => r.status === 429).length,
    status_0:     results.filter(r => r.status === 0).length,
    has_data:     results.filter(r => r.hasData).length,
  }

  return NextResponse.json({
    ok:          true,
    integration: { id: integ.id, department, business_id: integ.business_id },
    summary,
    analysis,
    results: [
      ...results.filter(r => r.status === 200),
      ...results.filter(r => r.status === 401).slice(0, 5),
      ...results.filter(r => r.status === 403).slice(0, 5),
      ...results.filter(r => r.status === 404).slice(0, 5),
      ...results.filter(r => r.status === 429).slice(0, 5),
    ],
  })
}

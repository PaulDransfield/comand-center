// @ts-nocheck
// app/api/admin/probe-inzii/route.ts
//
// Live API prober for Inzii/Swess POS.
// Fires real HTTP requests with the stored credentials across every plausible
// base-URL + endpoint + auth combination, collects every response (including
// error bodies — a 401 tells us auth format is wrong; a 404 tells us the base
// URL is right but path is wrong), then asks Claude to identify the winner.
//
// POST /api/admin/probe-inzii
//   Authorization: Bearer <ADMIN_SECRET>
//   { integration_id: "uuid" }           ← specific integration to probe
//   OR { org_id: "uuid" }               ← probes first inzii integration found

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'
import Anthropic                     from '@anthropic-ai/sdk'

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── All base URLs to try ──────────────────────────────────────────────────────
const BASE_URLS = [
  'https://api.swess.se',
  'https://api.swess.se/api/v1',
  'https://app.inzii.io',
  'https://api.inzii.io',
  'https://inzii.io/api',
  'https://portal.inzii.se',
  'https://api.inzii.se',
]

// ── Endpoint paths to try ─────────────────────────────────────────────────────
const PATHS = [
  '/sales',
  '/daily',
  '/daily-summary',
  '/reports/daily',
  '/report',
  '/z-reports',
  '/z-report',
  '/receipts',
  '/transactions',
  '/api/sales',
  '/api/daily',
  '/api/report',
]

// ── Date range for test data ──────────────────────────────────────────────────
function getTestDates() {
  const to   = new Date()
  const from = new Date(to.getTime() - 30 * 86400000)
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  }
}

// ── Build every candidate request ────────────────────────────────────────────
function buildCandidates(apiKey: string) {
  const { from, to } = getTestDates()
  const candidates: Array<{ url: string; headers: Record<string, string>; authType: string }> = []

  for (const base of BASE_URLS) {
    for (const path of PATHS) {
      // api_key query param
      candidates.push({
        url:      `${base}${path}?api_key=${apiKey}&from=${from}&to=${to}`,
        headers:  { Accept: 'application/json' },
        authType: 'query_api_key',
      })
      // token query param
      candidates.push({
        url:      `${base}${path}?token=${apiKey}&from=${from}&to=${to}`,
        headers:  { Accept: 'application/json' },
        authType: 'query_token',
      })
      // Bearer token
      candidates.push({
        url:      `${base}${path}?from=${from}&to=${to}`,
        headers:  { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        authType: 'bearer',
      })
      // x-api-key header
      candidates.push({
        url:      `${base}${path}?from=${from}&to=${to}`,
        headers:  { 'x-api-key': apiKey, Accept: 'application/json' },
        authType: 'x-api-key',
      })
    }
  }

  return candidates
}

// ── Fire one request, capture everything ─────────────────────────────────────
async function probe(candidate: ReturnType<typeof buildCandidates>[number]) {
  try {
    const res = await fetch(candidate.url, {
      headers: candidate.headers,
      signal:  AbortSignal.timeout(6000),
    })

    const contentType = res.headers.get('content-type') ?? ''
    let body: any = null
    try {
      body = contentType.includes('json')
        ? await res.json()
        : await res.text()
    } catch { body = null }

    return {
      url:        candidate.url.replace(/api_key=[^&]+/, 'api_key=***').replace(/token=[^&]+/, 'token=***'),
      authType:   candidate.authType,
      status:     res.status,
      contentType,
      body:       body,
      hasData:    res.status === 200 && body !== null,
    }
  } catch (err: any) {
    return {
      url:        candidate.url.replace(/api_key=[^&]+/, 'api_key=***').replace(/token=[^&]+/, 'token=***'),
      authType:   candidate.authType,
      status:     0,
      contentType: '',
      body:       err.message,
      hasData:    false,
    }
  }
}

// ── Ask Claude to interpret the probe results ─────────────────────────────────
async function askClaude(results: any[], apiKey: string, department: string) {
  // Only send interesting results to Claude — 200s and non-timeout errors
  const interesting = results.filter(r =>
    r.status === 200 || (r.status >= 400 && r.status < 500)
  ).slice(0, 30)

  if (interesting.length === 0) {
    return { conclusion: 'no_response', summary: 'All requests timed out or got network errors. The base URLs may be wrong or the server is down.', working_url: null, working_auth: null, sample_data: null }
  }

  const prompt = `
You are an API integration expert. I probed a Swedish restaurant POS system (Inzii/Swess) with many URL+auth combinations.
Below are all responses I got. Find the working endpoint that returns actual sales/revenue data.

Results (url with key redacted):
${JSON.stringify(interesting, null, 2)}

Department name: ${department}

Analyse these results and return JSON only:
{
  "conclusion": "found" | "auth_issue" | "wrong_urls" | "no_data" | "unknown",
  "summary": "one paragraph explaining what you found",
  "working_url_pattern": "the URL pattern that works, e.g. https://api.swess.se/sales?api_key=KEY&from=FROM&to=TO — or null",
  "working_auth_type": "query_api_key | bearer | x-api-key | query_token — or null",
  "base_url": "just the base, e.g. https://api.swess.se — or null",
  "path": "just the path, e.g. /sales — or null",
  "date_param_from": "the from date param name, e.g. from | date_from | start_date — or null",
  "date_param_to": "the to date param name, e.g. to | date_to | end_date — or null",
  "sample_fields": ["list of field names found in the data, if any"],
  "revenue_field": "the field name that contains net revenue/sales amount — or null",
  "date_field": "the field name for the date of each row — or null",
  "covers_field": "the field name for guest count / covers — or null",
  "next_step": "what to do next if not found"
}
`

  try {
    const msg = await anthropic.messages.create({
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
  const auth = req.headers.get('authorization')
  if (!auth || auth !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body           = await req.json().catch(() => ({}))
  const integrationId  = body.integration_id
  const orgId          = body.org_id
  const db             = createAdminClient()

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

  // Fire all probes
  console.log(`Probing Inzii API for department: ${department} (${integ.id})`)
  const candidates = buildCandidates(apiKey)

  // Run in batches of 20 to avoid overwhelming the server
  const results: any[] = []
  for (let i = 0; i < candidates.length; i += 20) {
    const batch = candidates.slice(i, i + 20)
    const batchResults = await Promise.all(batch.map(probe))
    results.push(...batchResults)

    // If we found a 200 response, stop early
    if (batchResults.some(r => r.status === 200 && r.hasData)) break
  }

  // Ask Claude to interpret
  const analysis = await askClaude(results, apiKey, department)

  // Save to api_discoveries_enhanced if we found something
  if (analysis.conclusion === 'found' && analysis.base_url) {
    try {
      await db.from('api_discoveries_enhanced').upsert({
        integration_id:       integ.id,
        org_id:               integ.org_id,
        business_id:          integ.business_id,
        provider:             'inzii',
        provider_type:        'pos',
        analysis_result:      { probe_analysis: analysis, raw_results: results.filter(r => r.status === 200) },
        discovered_at:        new Date().toISOString(),
        confidence_score:     90,
        data_type:            'revenue',
        unused_fields_count:  0,
        business_insights_count: 1,
      }, { onConflict: 'integration_id' })
    } catch (e: any) {
      console.warn('Could not save to api_discoveries_enhanced:', e.message)
    }
  }

  // Summary counts
  const summary = {
    total_probed:  results.length,
    status_200:    results.filter(r => r.status === 200).length,
    status_401:    results.filter(r => r.status === 401).length,
    status_403:    results.filter(r => r.status === 403).length,
    status_404:    results.filter(r => r.status === 404).length,
    status_0:      results.filter(r => r.status === 0).length,
    has_data:      results.filter(r => r.hasData).length,
  }

  return NextResponse.json({
    ok:         true,
    integration: { id: integ.id, department, business_id: integ.business_id },
    summary,
    analysis,
    // Return all 200s in full + first few of each other status
    results: [
      ...results.filter(r => r.status === 200),
      ...results.filter(r => r.status === 401).slice(0, 3),
      ...results.filter(r => r.status === 404).slice(0, 3),
    ],
  })
}

// @ts-nocheck
// app/api/admin/test-swess/route.ts
// TEMPORARY — probes the Inzii/Swess API to discover correct endpoints and field names.
// Remove after integration is confirmed working.
// Call: GET /api/admin/test-swess?secret=commandcenter123&key=YOUR_KEY

import { NextRequest, NextResponse } from 'next/server'

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

async function probe(label: string, url: string, headers: Record<string, string>) {
  try {
    const res  = await fetch(url, { headers })
    const text = await res.text()
    let body: any
    try { body = JSON.parse(text) } catch { body = text.slice(0, 500) }
    return { label, url, status: res.status, ok: res.ok, body }
  } catch (e: any) {
    return { label, url, status: 0, ok: false, error: e.message }
  }
}

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== 'commandcenter123') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const key = req.nextUrl.searchParams.get('key')
  if (!key) return NextResponse.json({ error: 'Missing key param' }, { status: 400 })

  const today    = new Date().toISOString().slice(0, 10)
  const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)

  // Try all plausible auth header formats
  const bearerHeaders   = { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' }
  const apiKeyHeaders   = { 'X-API-Key': key, 'Accept': 'application/json' }
  const basicHeaders    = { 'Authorization': `Basic ${Buffer.from(key + ':').toString('base64')}`, 'Accept': 'application/json' }
  const tokenHeaders    = { 'Authorization': `Token ${key}`, 'Accept': 'application/json' }

  // api.swess.se resolves (one.com hosted) — probe path variations
  // Key in query string variants
  const noAuthHeaders = { 'Accept': 'application/json' }

  const results = await Promise.all([
    // Root paths — find what exists
    probe('root /',                  `https://api.swess.se/`,                                                                       noAuthHeaders),
    probe('root /api',               `https://api.swess.se/api`,                                                                    noAuthHeaders),
    probe('root /api/v1',            `https://api.swess.se/api/v1`,                                                                 noAuthHeaders),
    probe('root /api/v2',            `https://api.swess.se/api/v2`,                                                                 noAuthHeaders),

    // Key as query param (common for simpler APIs)
    probe('?key= /sales',            `https://api.swess.se/api/v1/sales?key=${key}&from=${lastMonth}&to=${today}`,                  noAuthHeaders),
    probe('?api_key= /sales',        `https://api.swess.se/api/v1/sales?api_key=${key}&from=${lastMonth}&to=${today}`,              noAuthHeaders),
    probe('?token= /transactions',   `https://api.swess.se/api/v1/transactions?token=${key}&date_from=${lastMonth}&date_to=${today}`, noAuthHeaders),
    probe('?key= /reports/daily',    `https://api.swess.se/api/v1/reports/daily?key=${key}&from=${lastMonth}&to=${today}`,          noAuthHeaders),

    // Different path structures (no /api prefix)
    probe('/v1/sales (Bearer)',       `https://api.swess.se/v1/sales?from=${lastMonth}&to=${today}`,                                bearerHeaders),
    probe('/v1/reports (Bearer)',     `https://api.swess.se/v1/reports?from=${lastMonth}&to=${today}`,                              bearerHeaders),
    probe('/sales (Bearer)',          `https://api.swess.se/sales?from=${lastMonth}&to=${today}`,                                   bearerHeaders),
    probe('/sales (ApiKey hdr)',      `https://api.swess.se/sales?from=${lastMonth}&to=${today}`,                                   apiKeyHeaders),

    // Bearer on working domain, correct paths
    probe('/api/v1/sales (Bearer)',   `https://api.swess.se/api/v1/sales?from=${lastMonth}&to=${today}`,                            bearerHeaders),
    probe('/api/v1/daily (Bearer)',   `https://api.swess.se/api/v1/daily?from=${lastMonth}&to=${today}`,                            bearerHeaders),
    probe('/api/v1/report (Bearer)',  `https://api.swess.se/api/v1/report?from=${lastMonth}&to=${today}`,                           bearerHeaders),
    probe('/api/v1/receipts (Bearer)',`https://api.swess.se/api/v1/receipts?from=${lastMonth}&to=${today}`,                         bearerHeaders),

    // Maybe it's swess.se (no subdomain)
    probe('swess.se /api/v1 (Bearer)',`https://swess.se/api/v1/transactions?date_from=${lastMonth}&date_to=${today}`,               bearerHeaders),
    probe('swess.se /api/v1 (Key)',   `https://swess.se/api/v1/transactions?api_key=${key}&date_from=${lastMonth}&date_to=${today}`, noAuthHeaders),
  ])

  // Highlight which probes got a non-error response
  const hits = results.filter(r => r.ok)
  const near = results.filter(r => !r.ok && r.status > 0 && r.status !== 404)

  return NextResponse.json({
    tested_key_length: key.length,
    tested_key_prefix: key.slice(0, 4) + '...',
    summary: {
      successful_probes: hits.map(r => r.label),
      auth_errors:       near.map(r => `${r.label} → HTTP ${r.status}`),
      network_errors:    results.filter(r => r.status === 0).map(r => r.label),
    },
    results,
  })
}

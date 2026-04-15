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

  // Probe a range of plausible base URLs and endpoints
  const results = await Promise.all([
    // Current assumption — swess.se
    probe('swess/transactions (Bearer)',    `https://api.swess.se/api/v1/transactions?date_from=${lastMonth}&date_to=${today}`,     bearerHeaders),
    probe('swess/reports/daily (Bearer)',   `https://api.swess.se/api/v1/reports/daily?from=${lastMonth}&to=${today}`,              bearerHeaders),
    probe('swess/root (Bearer)',            `https://api.swess.se/api/v1`,                                                           bearerHeaders),
    probe('swess/root (ApiKey)',            `https://api.swess.se/api/v1`,                                                           apiKeyHeaders),

    // Inzii-branded alternatives
    probe('inzii/reports/daily (Bearer)',   `https://api.inzii.se/api/v1/reports/daily?from=${lastMonth}&to=${today}`,              bearerHeaders),
    probe('inzii/transactions (Bearer)',    `https://api.inzii.se/api/v1/transactions?date_from=${lastMonth}&date_to=${today}`,      bearerHeaders),
    probe('inzii/root (Bearer)',            `https://api.inzii.se/api/v1`,                                                           bearerHeaders),
    probe('inzii/root (ApiKey)',            `https://api.inzii.se/api/v1`,                                                           apiKeyHeaders),

    // Inzii without /api prefix
    probe('inzii.se/v1/reports (Bearer)',   `https://inzii.se/api/v1/reports/daily?from=${lastMonth}&to=${today}`,                  bearerHeaders),
    probe('inzii.se/v1/reports (ApiKey)',   `https://inzii.se/api/v1/reports/daily?from=${lastMonth}&to=${today}`,                  apiKeyHeaders),

    // Token-style auth variants on most likely base
    probe('swess/transactions (Token)',     `https://api.swess.se/api/v1/transactions?date_from=${lastMonth}&date_to=${today}`,      tokenHeaders),
    probe('swess/transactions (Basic)',     `https://api.swess.se/api/v1/transactions?date_from=${lastMonth}&date_to=${today}`,      basicHeaders),
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

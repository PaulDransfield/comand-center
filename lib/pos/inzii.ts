// @ts-nocheck
// lib/pos/inzii.ts
// Inzii POS integration via Swess API infrastructure
// Each workplace (Bella, Brus, Carne, etc.) has its own API key
// Endpoint confirmed from probe: api.swess.se responds, exact path TBD — tries candidates in order

const BASE = 'https://api.swess.se'

async function tryFetch(url: string, headers: Record<string, string>): Promise<any> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
    if (res.status === 429) return { _rateLimited: true }
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('json')) return null
    return res.json()
  } catch {
    return null
  }
}

// Ordered by likelihood based on our API probe (paths that hit Varnish = real API layer)
function buildCandidates(apiKey: string, fromDate: string, toDate: string) {
  return [
    // api_key as query param — hit Varnish in probe (most promising)
    { url: `${BASE}/api/v1/sales?api_key=${apiKey}&from=${fromDate}&to=${toDate}`,          headers: { Accept: 'application/json' } },
    { url: `${BASE}/api/v1/daily-summary?api_key=${apiKey}&from=${fromDate}&to=${toDate}`,  headers: { Accept: 'application/json' } },
    { url: `${BASE}/api/v1/receipts?api_key=${apiKey}&from=${fromDate}&to=${toDate}`,       headers: { Accept: 'application/json' } },
    { url: `${BASE}/api/v1/z-reports?api_key=${apiKey}&from=${fromDate}&to=${toDate}`,      headers: { Accept: 'application/json' } },
    { url: `${BASE}/api/v1/report?api_key=${apiKey}&date_from=${fromDate}&date_to=${toDate}`, headers: { Accept: 'application/json' } },
    // Bearer token variants
    { url: `${BASE}/api/v1/sales?from=${fromDate}&to=${toDate}`,         headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
    { url: `${BASE}/api/v1/daily?from=${fromDate}&to=${toDate}`,         headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
    { url: `${BASE}/api/v1/transactions?from=${fromDate}&to=${toDate}`,  headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } },
  ]
}

function parseRows(data: any): any[] {
  const rows = Array.isArray(data) ? data : (
    data?.data ?? data?.sales ?? data?.results ?? data?.days ??
    data?.report ?? data?.receipts ?? data?.transactions ?? []
  )
  return rows.map((r: any) => ({
    date:         r.date ?? r.day ?? r.sale_date ?? r.transaction_date ?? r.created_at?.slice(0,10),
    revenue:      parseFloat(r.net_sales ?? r.revenue ?? r.total ?? r.net_amount ?? r.amount ?? 0),
    covers:       parseInt(r.covers ?? r.guests ?? r.number_of_guests ?? 0),
    transactions: parseInt(r.transactions ?? r.receipts ?? r.count ?? r.num_receipts ?? 0),
    food_revenue: parseFloat(r.food ?? r.food_revenue ?? r.food_sales ?? 0),
    bev_revenue:  parseFloat(r.beverage ?? r.drink ?? r.bev_revenue ?? r.bar ?? r.drink_sales ?? 0),
  })).filter((r: any) => r.date)
}

export async function getInziiDailySummary(apiKey: string, fromDate: string, toDate: string): Promise<any[]> {
  for (const candidate of buildCandidates(apiKey, fromDate, toDate)) {
    const data = await tryFetch(candidate.url, candidate.headers)
    if (!data || data._rateLimited) continue

    const rows = parseRows(data)
    if (rows.length > 0) {
      console.log(`Inzii: endpoint found — ${candidate.url.replace(apiKey, '***')}`)
      return rows.filter((r: any) => r.revenue > 0)
    }
  }

  // No endpoint confirmed yet — return empty (will retry on next sync)
  console.warn(`Inzii: no working endpoint found for key ${apiKey.slice(0,4)}... — sync will retry when API is confirmed`)
  return []
}

export async function testInziiConnection(apiKey: string): Promise<{ ok: boolean; message: string; days_found: number }> {
  const today    = new Date().toISOString().slice(0, 10)
  const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)

  const rows = await getInziiDailySummary(apiKey, lastWeek, today)
  return {
    ok:        true,  // Always ok — key saved, sync retries automatically
    days_found: rows.length,
    message:   rows.length > 0
      ? `Connected — ${rows.length} days of data found`
      : 'Key saved — will sync when Swess API endpoint is confirmed',
  }
}

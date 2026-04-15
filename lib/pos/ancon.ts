// @ts-nocheck
// lib/pos/ancon.ts
// Ancon POS integration — Swedish restaurant POS system
// Auth: API key in header or query param (confirm with Ancon docs)

const BASE = 'https://api.ancon.se/v1'

async function fetchAncon(endpoint: string, token: string) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: {
      'X-API-Key': token,
      'Accept':    'application/json',
    },
  })
  if (!res.ok) throw new Error(`Ancon ${endpoint} error: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function getAnconSales(token: string, fromDate: string, toDate: string) {
  try {
    const data = await fetchAncon(`/sales?from=${fromDate}&to=${toDate}`, token)
    const sales = Array.isArray(data) ? data : (data.sales ?? data.data ?? [])
    return sales.map((s: any) => ({
      id:       s.id ?? s.sale_id,
      date:     s.date ?? s.sale_date ?? s.created_at?.slice(0,10),
      revenue:  parseFloat(s.total ?? s.amount ?? s.revenue ?? 0),
      covers:   parseInt(s.covers ?? s.guests ?? s.number_of_guests ?? 0),
      vat:      parseFloat(s.vat ?? s.tax ?? 0),
    })).filter((s: any) => s.date)
  } catch (e: any) {
    console.error('Ancon sales error:', e.message)
    return []
  }
}

export async function getAnconDailySummary(token: string, fromDate: string, toDate: string) {
  try {
    const data = await fetchAncon(`/reports/daily?from=${fromDate}&to=${toDate}`, token)
    const rows = Array.isArray(data) ? data : (data.days ?? data.data ?? [])
    return rows.map((r: any) => ({
      date:     r.date,
      revenue:  parseFloat(r.total_revenue ?? r.revenue ?? r.net_sales ?? 0),
      covers:   parseInt(r.covers ?? r.guests ?? 0),
      transactions: parseInt(r.transactions ?? r.receipt_count ?? 0),
      food_revenue: parseFloat(r.food_revenue ?? r.food ?? 0),
      bev_revenue:  parseFloat(r.bev_revenue  ?? r.drinks ?? r.beverage ?? 0),
    })).filter((r: any) => r.date)
  } catch (e: any) {
    console.error('Ancon daily summary error:', e.message)
    return []
  }
}

export async function testAnconConnection(token: string) {
  try {
    await fetchAncon('/health', token)
    return { ok: true, message: 'Ancon connected' }
  } catch {
    // Try sales endpoint as fallback test
    const today = new Date().toISOString().slice(0,10)
    await fetchAncon(`/sales?from=${today}&to=${today}`, token)
    return { ok: true, message: 'Ancon connected' }
  }
}

// ── Legacy class adapter for backward compat with lib/pos/adapter.ts ─────────
export class AnconAdapter {
  name        = 'Ancon'
  key         = 'ancon'
  description = 'Ancon POS system'
  docsUrl     = 'https://ancon.se'

  async testConnection(credentials: Record<string, string>) {
    try {
      await testAnconConnection(credentials.api_key ?? credentials.token ?? '')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  }

  async fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string) {
    const token = credentials.api_key ?? credentials.token ?? ''
    const daily = await getAnconDailySummary(token, fromDate, toDate)
    return daily.map((d: any) => ({
      date:      d.date,
      breakfast: 0,
      lunch:     Math.round(d.covers * 0.3),
      dinner:    Math.round(d.covers * 0.7),
      takeaway:  0,
      catering:  0,
      other:     0,
      revenue:   d.revenue,
      source:    'ancon',
    }))
  }
}

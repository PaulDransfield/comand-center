// @ts-nocheck
// lib/pos/swess.ts
// Swess POS integration — Swedish hospitality POS
// Auth: Bearer token

const BASE = 'https://api.swess.se/api/v1'

async function fetchSwess(endpoint: string, token: string) {
  const res = await fetch(`${BASE}${endpoint}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
  })
  if (!res.ok) throw new Error(`Swess ${endpoint} error: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function getSwessSales(token: string, fromDate: string, toDate: string) {
  try {
    const data = await fetchSwess(`/transactions?date_from=${fromDate}&date_to=${toDate}`, token)
    const sales = Array.isArray(data) ? data : (data.transactions ?? data.data ?? [])
    return sales.map((s: any) => ({
      id:      s.id,
      date:    s.date ?? s.transaction_date ?? s.created_at?.slice(0,10),
      revenue: parseFloat(s.total ?? s.amount ?? s.net_amount ?? 0),
      covers:  parseInt(s.guests ?? s.covers ?? s.number_of_covers ?? 0),
      vat:     parseFloat(s.vat ?? s.tax_amount ?? 0),
    })).filter((s: any) => s.date)
  } catch (e: any) {
    console.error('Swess sales error:', e.message)
    return []
  }
}

export async function getSwessDailySummary(token: string, fromDate: string, toDate: string) {
  try {
    const data = await fetchSwess(`/reports/daily?from=${fromDate}&to=${toDate}`, token)
    const rows = Array.isArray(data) ? data : (data.report ?? data.days ?? data.data ?? [])
    return rows.map((r: any) => ({
      date:         r.date,
      revenue:      parseFloat(r.net_sales ?? r.total_revenue ?? r.revenue ?? 0),
      covers:       parseInt(r.covers ?? r.guests ?? 0),
      transactions: parseInt(r.transactions ?? r.receipts ?? 0),
      food_revenue: parseFloat(r.food ?? r.food_revenue ?? 0),
      bev_revenue:  parseFloat(r.beverage ?? r.drink ?? r.bev_revenue ?? 0),
    })).filter((r: any) => r.date)
  } catch (e: any) {
    console.error('Swess daily summary error:', e.message)
    return []
  }
}

export async function testSwessConnection(token: string) {
  const today = new Date().toISOString().slice(0,10)
  await fetchSwess(`/transactions?date_from=${today}&date_to=${today}`, token)
  return { ok: true, message: 'Swess connected' }
}

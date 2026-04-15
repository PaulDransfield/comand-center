// lib/pos/wolt.ts
// Wolt delivery platform adapter
// API docs: https://developer.wolt.com (Partner API)
//
// Credentials needed:
//   api_key     — from Wolt Partner Portal → Integrations
//   venue_id    — your restaurant's venue ID in Wolt

import { POSAdapter, DailyCoverData } from './adapter'

const WOLT_API = 'https://restaurant-api.wolt.com/v1'

export class WoltAdapter implements POSAdapter {
  name        = 'Wolt'
  key         = 'wolt'
  description = 'Matleverans — orderdata, intäkter och provisioner'
  docsUrl     = 'https://developer.wolt.com'

  async testConnection(credentials: Record<string, string>, config: Record<string, any>) {
    const { api_key } = credentials
    const { venue_id } = config
    if (!api_key || !venue_id) return { ok: false, error: 'API key and Venue ID required' }

    try {
      const res = await fetch(`${WOLT_API}/venues/${venue_id}`, {
        headers: { 'Authorization': `Bearer ${api_key}` },
      })
      if (!res.ok) return { ok: false, error: `Wolt API error: ${res.status}` }
      const data = await res.json()
      return { ok: true, info: { venue_name: data.name ?? venue_id } }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  async fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string): Promise<DailyCoverData[]> {
    const { api_key } = credentials
    const { venue_id } = config

    try {
      const res = await fetch(
        `${WOLT_API}/venues/${venue_id}/orders?from=${fromDate}&to=${toDate}&status=delivered`,
        { headers: { 'Authorization': `Bearer ${api_key}` } }
      )
      if (!res.ok) return []
      const data = await res.json()
      const orders: any[] = data.orders ?? data.items ?? []

      // Aggregate by date
      const byDate: Record<string, { revenue: number; count: number }> = {}
      for (const o of orders) {
        const date    = (o.created_at ?? o.delivered_at ?? '').slice(0, 10)
        if (!date) continue
        if (!byDate[date]) byDate[date] = { revenue: 0, count: 0 }
        // Net revenue = order total minus Wolt commission
        const gross      = parseFloat(o.consumer_amount ?? o.total ?? 0) / 100
        const commission = parseFloat(o.venue_commission ?? 0) / 100
        byDate[date].revenue += gross - commission
        byDate[date].count++
      }

      return Object.entries(byDate).map(([date, day]) => ({
        date,
        breakfast: 0,
        lunch:     0,
        dinner:    0,
        takeaway:  day.count,  // Wolt orders go to takeaway
        catering:  0,
        other:     0,
        revenue:   day.revenue,
        source:    'wolt',
      }))
    } catch {
      return []
    }
  }
}

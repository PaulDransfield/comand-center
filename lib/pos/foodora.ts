// lib/pos/foodora.ts
// Foodora delivery platform adapter
// API docs: https://partner.foodora.se (Partner Portal)
//
// Credentials needed:
//   api_key      — from Foodora Partner Portal → API Access
//   restaurant_id — your restaurant ID on Foodora

import { POSAdapter, DailyCoverData } from './adapter'

const FOODORA_API = 'https://partner-api.foodora.com/v1'

export class FoodoraAdapter implements POSAdapter {
  name        = 'Foodora'
  key         = 'foodora'
  description = 'Matleverans — orderdata, intäkter och provisioner'
  docsUrl     = 'https://partner.foodora.se'

  async testConnection(credentials: Record<string, string>, config: Record<string, any>) {
    const { api_key } = credentials
    const { restaurant_id } = config
    if (!api_key || !restaurant_id) return { ok: false, error: 'API key and Restaurant ID required' }

    try {
      const res = await fetch(`${FOODORA_API}/restaurants/${restaurant_id}`, {
        headers: { 'Authorization': `Bearer ${api_key}` },
      })
      if (!res.ok) return { ok: false, error: `Foodora API error: ${res.status}` }
      const data = await res.json()
      return { ok: true, info: { restaurant_name: data.name ?? restaurant_id } }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  async fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string): Promise<DailyCoverData[]> {
    const { api_key } = credentials
    const { restaurant_id } = config

    try {
      const res = await fetch(
        `${FOODORA_API}/restaurants/${restaurant_id}/orders?from=${fromDate}&to=${toDate}`,
        { headers: { 'Authorization': `Bearer ${api_key}` } }
      )
      if (!res.ok) return []
      const data = await res.json()
      const orders: any[] = data.orders ?? []

      const byDate: Record<string, { revenue: number; count: number }> = {}
      for (const o of orders) {
        const date = (o.delivery_time ?? o.created_at ?? '').slice(0, 10)
        if (!date) continue
        if (!byDate[date]) byDate[date] = { revenue: 0, count: 0 }
        const net = parseFloat(o.restaurant_revenue ?? o.subtotal ?? 0) / 100
        byDate[date].revenue += net
        byDate[date].count++
      }

      return Object.entries(byDate).map(([date, day]) => ({
        date,
        breakfast: 0,
        lunch:     0,
        dinner:    0,
        takeaway:  day.count,
        catering:  0,
        other:     0,
        revenue:   day.revenue,
        source:    'foodora',
      }))
    } catch {
      return []
    }
  }
}

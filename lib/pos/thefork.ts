// lib/pos/thefork.ts
// TheFork (The Fork Manager) booking adapter
// API docs: https://docs.thefork.io
// Auth: OAuth2 — client_id + client_secret → Bearer token
//
// Credentials needed:
//   client_id     — from TheFork Developer Portal (docs.thefork.io)
//   client_secret — from TheFork Developer Portal
// Config:
//   restaurant_id — your restaurant's CustomerId in TheFork

import { POSAdapter, DailyCoverData } from './adapter'

const THEFORK_AUTH = 'https://auth.thefork.io/oauth/token'
const THEFORK_API  = 'https://api.thefork.io/manager/v1'

export class TheForkAdapter implements POSAdapter {
  name        = 'TheFork'
  key         = 'thefork'
  description = 'Europas ledande bokningsplattform — reservationer och gästdata'
  docsUrl     = 'https://docs.thefork.io'

  private async getToken(clientId: string, clientSecret: string): Promise<string | null> {
    try {
      const res = await fetch(THEFORK_AUTH, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          client_id:     clientId,
          client_secret: clientSecret,
          audience:      'https://api.thefork.io',
          grant_type:    'client_credentials',
        }),
      })
      if (!res.ok) return null
      const data = await res.json()
      return data.access_token ?? null
    } catch { return null }
  }

  async testConnection(credentials: Record<string, string>, config: Record<string, any>) {
    const { client_id, client_secret } = credentials
    const { restaurant_id }            = config

    if (!client_id || !client_secret) {
      return { ok: false, error: 'Client ID and Client Secret required' }
    }

    const token = await this.getToken(client_id, client_secret)
    if (!token) return { ok: false, error: 'Could not get access token — check credentials' }

    if (!restaurant_id) return { ok: true, info: { message: 'Token OK — add Restaurant ID to complete setup' } }

    try {
      const res = await fetch(`${THEFORK_API}/restaurants/${restaurant_id}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'CustomerId':    restaurant_id,
        },
      })
      if (!res.ok) return { ok: false, error: `TheFork API error: ${res.status}` }
      const data = await res.json()
      return { ok: true, info: { restaurant_name: data.name ?? restaurant_id } }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  async fetchCovers(
    credentials:  Record<string, string>,
    config:       Record<string, any>,
    fromDate:     string,
    toDate:       string,
  ): Promise<DailyCoverData[]> {
    const { client_id, client_secret } = credentials
    const { restaurant_id }            = config

    const token = await this.getToken(client_id, client_secret)
    if (!token || !restaurant_id) return []

    try {
      // Fetch reservations in date range
      const res = await fetch(
        `${THEFORK_API}/restaurants/${restaurant_id}/reservations?dateFrom=${fromDate}&dateTo=${toDate}&status=seated,confirmed`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'CustomerId':    restaurant_id,
          },
        }
      )
      if (!res.ok) return []
      const data = await res.json()
      const reservations: any[] = data.reservations ?? data.items ?? []

      // Aggregate by date + service period
      const byDate: Record<string, {
        lunch: number; dinner: number; other: number
        revenue: number
      }> = {}

      for (const r of reservations) {
        const date    = (r.visitDate ?? r.date ?? '').slice(0, 10)
        const covers  = parseInt(r.numberOfPeople ?? r.covers ?? 0)
        const time    = (r.visitTime ?? r.time ?? '00:00')
        const hour    = parseInt(time.split(':')[0])
        const revenue = parseFloat(r.totalAmount ?? r.revenue ?? 0)

        if (!date || covers === 0) continue
        if (!byDate[date]) byDate[date] = { lunch: 0, dinner: 0, other: 0, revenue: 0 }

        // Classify by time of day
        if (hour >= 11 && hour < 15)      byDate[date].lunch  += covers
        else if (hour >= 17 && hour < 24) byDate[date].dinner += covers
        else                               byDate[date].other  += covers

        byDate[date].revenue += revenue
      }

      return Object.entries(byDate).map(([date, day]) => ({
        date,
        breakfast: 0,
        lunch:     day.lunch,
        dinner:    day.dinner,
        takeaway:  0,
        catering:  0,
        other:     day.other,
        revenue:   day.revenue,
        source:    'thefork',
      }))
    } catch {
      return []
    }
  }
}

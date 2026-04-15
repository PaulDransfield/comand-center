// lib/pos/zettle.ts
// Zettle by PayPal adapter
// API docs: https://developer.zettle.com
// Uses OAuth2 — credentials stored as access_token + refresh_token
//
// Credentials needed:
//   client_id     — from Zettle developer portal
//   client_secret — from Zettle developer portal
// Config:
//   (no unit_id needed — Zettle uses the authenticated account)

import { POSAdapter, DailyCoverData } from './adapter'

const ZETTLE_API   = 'https://purchase.izettle.com'
const ZETTLE_TOKEN = 'https://oauth.zettle.com/token'

export class ZettleAdapter implements POSAdapter {
  name        = 'Zettle by PayPal'
  key         = 'zettle'
  description = 'Populärt kassasystem — gratis grundversion, 1.85% kortavgift'
  docsUrl     = 'https://developer.zettle.com'

  async testConnection(credentials: Record<string, string>) {
    const { client_id, client_secret } = credentials
    if (!client_id || !client_secret) return { ok: false, error: 'Client ID and Client Secret required' }

    try {
      const token = await this.getToken(client_id, client_secret)
      if (!token) return { ok: false, error: 'Failed to get access token' }
      return { ok: true, info: { message: 'Connected to Zettle' } }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  private async getToken(clientId: string, clientSecret: string): Promise<string | null> {
    const res = await fetch(ZETTLE_TOKEN, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id:     clientId,
        client_secret: clientSecret,
        assertion:     clientSecret,
      }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.access_token ?? null
  }

  async fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string): Promise<DailyCoverData[]> {
    const { client_id, client_secret } = credentials
    const token = await this.getToken(client_id, client_secret)
    if (!token) return []

    try {
      // Zettle purchases API — get all purchases in range
      const res = await fetch(
        `${ZETTLE_API}/purchases/v2?startDate=${fromDate}T00:00:00&endDate=${toDate}T23:59:59&limit=1000`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      )
      if (!res.ok) return []
      const data = await res.json()
      const purchases: any[] = data.purchases ?? []

      // Aggregate by date
      const byDate: Record<string, { revenue: number; count: number }> = {}
      for (const p of purchases) {
        const date = p.timestamp?.slice(0, 10)
        if (!date) continue
        if (!byDate[date]) byDate[date] = { revenue: 0, count: 0 }
        byDate[date].revenue += (p.amount ?? 0) / 100  // Zettle uses minor currency units
        byDate[date].count++
      }

      return Object.entries(byDate).map(([date, day]) => ({
        date,
        breakfast: 0,
        lunch:     0,
        dinner:    0,
        takeaway:  0,
        catering:  0,
        other:     day.count,  // Zettle doesn't split by period — put in other
        revenue:   day.revenue,
        source:    'zettle',
      }))
    } catch {
      return []
    }
  }
}

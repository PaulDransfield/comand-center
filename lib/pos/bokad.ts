// lib/pos/bokad.ts
// Bokad.se booking system adapter
// Bokad.se is a Swedish restaurant reservation system
// API docs: https://bokad.se/api (contact bokad.se for API access)
//
// Credentials needed:
//   api_key       — from Bokad.se account → Settings → API
// Config:
//   restaurant_id — your restaurant ID on Bokad.se

import { POSAdapter, DailyCoverData } from './adapter'

const BOKAD_API = 'https://api.bokad.se/v1'

export class BokadAdapter implements POSAdapter {
  name        = 'Bokad.se'
  key         = 'bokad'
  description = 'Svenskt bokningssystem — reservationer och bordshantering'
  docsUrl     = 'https://bokad.se'

  async testConnection(credentials: Record<string, string>, config: Record<string, any>) {
    const { api_key }       = credentials
    const { restaurant_id } = config

    if (!api_key || !restaurant_id) {
      return { ok: false, error: 'API key and Restaurant ID required' }
    }

    try {
      const res = await fetch(`${BOKAD_API}/restaurants/${restaurant_id}`, {
        headers: {
          'Authorization': `Bearer ${api_key}`,
          'Accept':        'application/json',
        },
      })
      if (!res.ok) return { ok: false, error: `Bokad API error: ${res.status}` }
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
    const { api_key }       = credentials
    const { restaurant_id } = config

    try {
      const res = await fetch(
        `${BOKAD_API}/restaurants/${restaurant_id}/bookings?from=${fromDate}&to=${toDate}`,
        {
          headers: {
            'Authorization': `Bearer ${api_key}`,
            'Accept':        'application/json',
          },
        }
      )
      if (!res.ok) return []
      const data = await res.json()
      const bookings: any[] = data.bookings ?? data.reservations ?? []

      // Aggregate by date + service period
      const byDate: Record<string, {
        lunch: number; dinner: number; breakfast: number; other: number
      }> = {}

      for (const b of bookings) {
        // Skip cancelled/no-show bookings
        if (['cancelled', 'no_show', 'noshow'].includes(b.status?.toLowerCase())) continue

        const date   = (b.date ?? b.booking_date ?? '').slice(0, 10)
        const covers = parseInt(b.guests ?? b.covers ?? b.party_size ?? 0)
        const time   = (b.time ?? b.booking_time ?? '18:00')
        const hour   = parseInt(time.split(':')[0])

        if (!date || covers === 0) continue
        if (!byDate[date]) byDate[date] = { lunch: 0, dinner: 0, breakfast: 0, other: 0 }

        if (hour >= 7  && hour < 11) byDate[date].breakfast += covers
        else if (hour >= 11 && hour < 15) byDate[date].lunch += covers
        else if (hour >= 17)              byDate[date].dinner += covers
        else                              byDate[date].other  += covers
      }

      return Object.entries(byDate).map(([date, day]) => ({
        date,
        breakfast: day.breakfast,
        lunch:     day.lunch,
        dinner:    day.dinner,
        takeaway:  0,
        catering:  0,
        other:     day.other,
        revenue:   0,  // Bokad.se doesn't have revenue data — comes from POS
        source:    'bokad',
      }))
    } catch {
      return []
    }
  }
}

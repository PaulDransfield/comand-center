// lib/pos/trivec.ts
// Trivec POS adapter (now part of Caspeco group)
// API docs: https://developer.trivec.com
//
// Credentials needed:
//   api_key   — from Trivec developer portal (mytrivec.com → API)
//   unit_id   — restaurant unit ID

import { POSAdapter, DailyCoverData } from './adapter'

const TRIVEC_API = 'https://api.trivec.com/v1'

export class TrivecAdapter implements POSAdapter {
  name        = 'Trivec'
  key         = 'trivec'
  description = 'Kassasystem för restaurang & bar — del av Caspeco-gruppen'
  docsUrl     = 'https://mytrivec.com'

  async testConnection(credentials: Record<string, string>, config: Record<string, any>) {
    const { api_key } = credentials
    const { unit_id } = config
    if (!api_key || !unit_id) return { ok: false, error: 'API key and Unit ID required' }

    try {
      const res = await fetch(`${TRIVEC_API}/units/${unit_id}`, {
        headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) return { ok: false, error: `Trivec API error: ${res.status}` }
      const data = await res.json()
      return { ok: true, info: { unit_name: data.name ?? unit_id } }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  async fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string): Promise<DailyCoverData[]> {
    const { api_key } = credentials
    const { unit_id } = config

    try {
      const res = await fetch(`${TRIVEC_API}/units/${unit_id}/reports/daily?from=${fromDate}&to=${toDate}`, {
        headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) return []
      const data = await res.json()
      const days: any[] = data.days ?? data.reports ?? []

      return days.map(day => ({
        date:      day.date,
        breakfast: day.breakfast ?? 0,
        lunch:     day.lunch     ?? day.lunch_covers ?? 0,
        dinner:    day.dinner    ?? day.dinner_covers ?? 0,
        takeaway:  (day.takeaway ?? 0) + (day.delivery ?? 0),
        catering:  day.catering  ?? 0,
        other:     day.other     ?? 0,
        revenue:   parseFloat(day.net_sales ?? day.total_excl_vat ?? 0),
        source:    'trivec',
      }))
    } catch {
      return []
    }
  }
}

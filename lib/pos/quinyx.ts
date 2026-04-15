// lib/pos/quinyx.ts
// Quinyx workforce management adapter
// Pulls scheduled hours and actual worked hours for labour cost tracking
// API docs: https://api.quinyx.com
//
// Credentials needed:
//   api_key — from Quinyx admin → Integrations → API Keys
// Config:
//   group_id — the Quinyx group/unit ID for this restaurant

import { POSAdapter, DailyCoverData } from './adapter'

const QUINYX_API = 'https://api.quinyx.com/v2'

export class QuinyxAdapter implements POSAdapter {
  name        = 'Quinyx'
  key         = 'quinyx'
  description = 'AI-driven workforce management — schemaläggning & tidrapportering'
  docsUrl     = 'https://api.quinyx.com'

  async testConnection(credentials: Record<string, string>, config: Record<string, any>) {
    const { api_key } = credentials
    if (!api_key) return { ok: false, error: 'API key required' }

    try {
      const res = await fetch(`${QUINYX_API}/groups`, {
        headers: { 'Authorization': `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) return { ok: false, error: `Quinyx API error: ${res.status}` }
      return { ok: true, info: { message: 'Connected to Quinyx' } }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  }

  // Quinyx gives us staff hours, not covers — we return revenue=0, other=total_hours
  async fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string): Promise<DailyCoverData[]> {
    const { api_key } = credentials
    const { group_id } = config

    try {
      // Fetch time reports (actual worked hours)
      const res = await fetch(
        `${QUINYX_API}/time-reports?groupId=${group_id}&startDate=${fromDate}&endDate=${toDate}`,
        { headers: { 'Authorization': `Bearer ${api_key}` } }
      )
      if (!res.ok) return []
      const data = await res.json()
      const reports: any[] = data.timeReports ?? data.data ?? []

      // Aggregate hours by date
      const byDate: Record<string, number> = {}
      for (const r of reports) {
        const date  = r.date ?? r.workDate
        const hours = parseFloat(r.workedMinutes ?? r.actualMinutes ?? 0) / 60
        if (date) byDate[date] = (byDate[date] ?? 0) + hours
      }

      // Note: we store hours in the `other` field
      // The covers page will show this labelled as "Staff hours" for Quinyx connections
      return Object.entries(byDate).map(([date, hours]) => ({
        date,
        breakfast: 0,
        lunch:     0,
        dinner:    0,
        takeaway:  0,
        catering:  0,
        other:     Math.round(hours),
        revenue:   0,
        source:    'quinyx',
      }))
    } catch {
      return []
    }
  }
}

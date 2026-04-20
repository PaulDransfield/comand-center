'use client'
// @ts-nocheck
// components/WeatherStrip.tsx — 7-day forecast row shown on the dashboard.
// Falls back to null if forecast fetch fails or no business is selected, so
// pages that embed it don't gain a big empty card.

import { useEffect, useState } from 'react'

interface Forecast {
  date: string
  temp_min: number
  temp_max: number
  precip_mm: number
  weather_code: number
  summary: string
}

const EMOJI: Record<number, string> = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌧️',
  56: '🌨️', 57: '🌨️',
  61: '🌦️', 63: '🌧️', 65: '🌧️',
  66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '❄️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function WeatherStrip({ businessId }: { businessId?: string }) {
  const [data, setData] = useState<{ city: string; forecast: Forecast[] } | null>(null)
  const [err,  setErr]  = useState('')

  useEffect(() => {
    if (!businessId) return
    fetch(`/api/weather/forecast?business_id=${businessId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setErr(j.error); else setData(j) })
      .catch(e => setErr(e.message))
  }, [businessId])

  if (!businessId || err || !data?.forecast?.length) return null

  return (
    <div style={{
      background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 10,
      padding: '10px 14px', marginBottom: 16,
      display: 'flex', alignItems: 'center', gap: 14, overflowX: 'auto',
      fontFamily: '-apple-system, "Segoe UI", sans-serif',
    }}>
      <div style={{ fontSize: 11, color: '#6b7280', letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
        Next 7 days · {data.city}
      </div>
      {data.forecast.map(f => {
        const dow = DAYS[new Date(f.date).getUTCDay()]
        const day = new Date(f.date).getUTCDate()
        return (
          <div key={f.date} style={{ minWidth: 74, textAlign: 'center', fontSize: 12, flexShrink: 0 }}>
            <div style={{ color: '#6b7280', fontSize: 10 }}>{dow} {day}</div>
            <div style={{ fontSize: 18, lineHeight: 1.1, margin: '2px 0' }}>{EMOJI[f.weather_code] ?? '·'}</div>
            <div style={{ fontWeight: 600, fontSize: 12 }}>
              {Math.round(f.temp_min)}° / {Math.round(f.temp_max)}°
            </div>
            {f.precip_mm > 0.5 && (
              <div style={{ fontSize: 10, color: '#2563eb' }}>{f.precip_mm}mm</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

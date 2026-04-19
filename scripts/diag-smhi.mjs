#!/usr/bin/env node
// Quick probe — Open-Meteo Stockholm 10-day forecast.
const lat = 59.3293, lon = 18.0686
const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max&timezone=Europe/Stockholm&forecast_days=10&wind_speed_unit=ms`
const r = await fetch(url, { headers: { Accept: 'application/json' } })
if (!r.ok) { console.error(r.status, await r.text()); process.exit(1) }
const j = await r.json()
const d = j.daily
console.log(`10-day forecast for Stockholm (Open-Meteo):`)
for (let i = 0; i < d.time.length; i++) {
  const day = new Date(d.time[i]).toLocaleDateString('en-GB', { weekday: 'short' })
  console.log(`  ${d.time[i]} ${day}: ${d.temperature_2m_min[i]}..${d.temperature_2m_max[i]}°C, ${d.precipitation_sum[i]}mm, wind ${d.wind_speed_10m_max[i]}m/s, code=${d.weather_code[i]}`)
}

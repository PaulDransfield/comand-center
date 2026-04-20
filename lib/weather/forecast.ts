// lib/weather/forecast.ts
//
// Weather forecast fetcher backed by Open-Meteo (https://open-meteo.com).
// Free, no API key, global coverage. Sourced from European met institutes
// including SMHI so accuracy for Sweden matches SMHI's own feed.
//
// We tried SMHI direct first but their open-data endpoint returns 404 as of
// 2026-04-19 — suspected API migration. Open-Meteo is a reliable fallback
// with a friendlier JSON shape.

export interface DailyWeather {
  date:          string   // YYYY-MM-DD (business-local timezone)
  temp_min:      number   // °C
  temp_max:      number
  temp_avg:      number   // computed (min+max)/2
  precip_mm:     number   // total rainfall for the day
  wind_max:      number   // peak wind m/s
  weather_code:  number   // WMO code (see WMO2str)
  summary:       string   // human-readable label
}

// WMO code → short label. Collapsed to what matters for a restaurant.
const WMO2str: Record<number, string> = {
  0:  'Clear',
  1:  'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Light freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers', 81: 'Heavy rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm',
}

const cache = new Map<string, { fetched: number; data: DailyWeather[] }>()
const TTL_MS = 60 * 60 * 1000  // 1h — forecasts update every ~3h

export async function getForecast(lat: number, lon: number): Promise<DailyWeather[]> {
  const key = `${lat.toFixed(3)}:${lon.toFixed(3)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.fetched < TTL_MS) return hit.data

  // 16 days of forecast — Open-Meteo's max. The default 10 is just barely
  // short: on a Monday, "next week" (Mon-Sun) runs +7 through +13 days, so
  // a 10-day horizon only covers the first 3 days of next week. 16 gives us
  // the whole of next week plus a 2-day buffer.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max&timezone=Europe/Stockholm&forecast_days=16&wind_speed_unit=ms`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()

  const d = json.daily
  if (!d?.time?.length) {
    cache.set(key, { fetched: Date.now(), data: [] })
    return []
  }

  const daily: DailyWeather[] = d.time.map((date: string, i: number) => {
    const max = Number(d.temperature_2m_max?.[i] ?? 0)
    const min = Number(d.temperature_2m_min?.[i] ?? 0)
    const code = Number(d.weather_code?.[i] ?? 0)
    return {
      date,
      temp_min:     Math.round(min * 10) / 10,
      temp_max:     Math.round(max * 10) / 10,
      temp_avg:     Math.round(((min + max) / 2) * 10) / 10,
      precip_mm:    Math.round(Number(d.precipitation_sum?.[i] ?? 0) * 10) / 10,
      wind_max:     Math.round(Number(d.wind_speed_10m_max?.[i] ?? 0) * 10) / 10,
      weather_code: code,
      summary:      WMO2str[code] ?? 'Unknown',
    }
  })

  cache.set(key, { fetched: Date.now(), data: daily })
  return daily
}

// ── City → coord lookup (avoids a schema migration today) ───────────────────
// If the business has a matching city we geocode locally; else default to
// Stockholm Central. When we onboard non-SE customers we'll add lat/lon to
// the businesses table properly.
const CITY_COORDS: Record<string, { lat: number; lon: number }> = {
  stockholm: { lat: 59.3293, lon: 18.0686 },
  göteborg:  { lat: 57.7089, lon: 11.9746 },
  goteborg:  { lat: 57.7089, lon: 11.9746 },
  gothenburg:{ lat: 57.7089, lon: 11.9746 },
  malmö:     { lat: 55.6050, lon: 13.0038 },
  malmo:     { lat: 55.6050, lon: 13.0038 },
  uppsala:   { lat: 59.8586, lon: 17.6389 },
  lund:      { lat: 55.7047, lon: 13.1910 },
  örebro:    { lat: 59.2741, lon: 15.2066 },
  orebro:    { lat: 59.2741, lon: 15.2066 },
  linköping: { lat: 58.4108, lon: 15.6214 },
  linkoping: { lat: 58.4108, lon: 15.6214 },
  helsingborg: { lat: 56.0465, lon: 12.6945 },
  jönköping: { lat: 57.7826, lon: 14.1618 },
  norrköping: { lat: 58.5877, lon: 16.1924 },
  umeå:      { lat: 63.8258, lon: 20.2630 },
  umea:      { lat: 63.8258, lon: 20.2630 },
  västerås:  { lat: 59.6099, lon: 16.5448 },
  vasteras:  { lat: 59.6099, lon: 16.5448 },
  gävle:     { lat: 60.6749, lon: 17.1413 },
  gavle:     { lat: 60.6749, lon: 17.1413 },
}
const DEFAULT_COORD = CITY_COORDS.stockholm

export function coordsFor(city: string | null | undefined): { lat: number; lon: number } {
  if (!city) return DEFAULT_COORD
  const key = city.toLowerCase().trim()
  return CITY_COORDS[key] ?? DEFAULT_COORD
}

// ── Historical weather (archive API) ────────────────────────────────────────
// Open-Meteo's ERA5 reanalysis — observed weather, free, same JSON shape as
// the forecast endpoint. Used for one-time backfill of `weather_daily` so we
// can correlate past sales to weather.
//
// Data typically lags 2 days behind real-time. Request ranges that extend
// into the last 48h will be capped server-side. For recent days combine this
// with the forecast endpoint.
export async function getHistoricalWeather(
  lat: number,
  lon: number,
  fromDate: string,  // YYYY-MM-DD
  toDate:   string,
): Promise<DailyWeather[]> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&start_date=${fromDate}&end_date=${toDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max&timezone=Europe/Stockholm&wind_speed_unit=ms`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()

  const d = json.daily
  if (!d?.time?.length) return []

  return d.time.map((date: string, i: number) => {
    const max = Number(d.temperature_2m_max?.[i] ?? 0)
    const min = Number(d.temperature_2m_min?.[i] ?? 0)
    const code = Number(d.weather_code?.[i] ?? 0)
    return {
      date,
      temp_min:     Math.round(min * 10) / 10,
      temp_max:     Math.round(max * 10) / 10,
      temp_avg:     Math.round(((min + max) / 2) * 10) / 10,
      precip_mm:    Math.round(Number(d.precipitation_sum?.[i] ?? 0) * 10) / 10,
      wind_max:     Math.round(Number(d.wind_speed_10m_max?.[i] ?? 0) * 10) / 10,
      weather_code: code,
      summary:      WMO2str[code] ?? 'Unknown',
    }
  })
}

// ── Bucketing for correlation analysis ──────────────────────────────────────
// Groups weather into bands a restaurant owner would intuitively use when
// thinking about staffing. Not a pure meteorological classification — this
// is about what moves footfall.
export function weatherBucket(w: { temp_avg: number; precip_mm: number; weather_code: number }): string {
  if (w.precip_mm >= 5)                             return 'wet'           // substantial rain/snow
  if (w.weather_code >= 71 && w.weather_code <= 77) return 'snow'
  if (w.weather_code >= 95)                         return 'thunder'
  if (w.temp_avg < 0)                               return 'freezing'
  if (w.temp_avg < 5)                               return 'cold_dry'
  if (w.temp_avg >= 20)                             return 'hot'
  if (w.weather_code <= 1 && w.precip_mm < 1)       return 'clear'
  return 'mild'
}

export const BUCKET_ORDER = ['clear', 'mild', 'cold_dry', 'wet', 'snow', 'freezing', 'hot', 'thunder']

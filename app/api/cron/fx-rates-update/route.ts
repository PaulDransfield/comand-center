// app/api/cron/fx-rates-update/route.ts
//
// Daily ECB fx rate ingestion.
//
// ECB publishes daily reference rates against EUR base at ~16:00 CET on
// TARGET2 business days. We fetch the daily XML, convert the rates we
// care about (USD/NOK/DKK/GBP) into SEK terms, and upsert into fx_rates.
//
// EUR → SEK = the EUR/SEK rate in the feed
// USD → SEK = (EUR/SEK rate) / (EUR/USD rate)
// (Cross-rate via EUR base; ECB doesn't publish SEK-direct.)
//
// Auth: Bearer CRON_SECRET (or ADMIN_SECRET for manual kick).
// Runs daily at 17:00 UTC (after ECB publishes).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
const CURRENCIES = ['USD', 'NOK', 'DKK', 'GBP'] as const

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }   // Vercel cron sends GET

async function handle(req: NextRequest) {
  noStore()
  const auth = req.headers.get('authorization') ?? ''
  const cronSecret  = process.env.CRON_SECRET
  const adminSecret = process.env.ADMIN_SECRET
  if (!(cronSecret  && auth === `Bearer ${cronSecret}`)  &&
      !(adminSecret && auth === `Bearer ${adminSecret}`)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // 1. Fetch ECB XML
  let xml: string
  try {
    const res = await fetch(ECB_URL, { cache: 'no-store' })
    if (!res.ok) throw new Error(`ECB HTTP ${res.status}`)
    xml = await res.text()
  } catch (e: any) {
    return NextResponse.json({ error: `ECB fetch failed: ${e?.message ?? e}` }, { status: 502 })
  }

  // 2. Parse — the XML is small + regular. Look for:
  //    <Cube time='2026-05-24'>
  //      <Cube currency='USD' rate='1.0830'/>
  //      …
  const dateMatch = xml.match(/<Cube\s+time=['"]([\d-]+)['"]/)
  if (!dateMatch) return NextResponse.json({ error: 'no date in ECB XML' }, { status: 502 })
  const rateDate = dateMatch[1]   // YYYY-MM-DD

  const ratesAgainstEUR: Record<string, number> = {}
  const cubeRe = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = cubeRe.exec(xml)) !== null) {
    ratesAgainstEUR[m[1]] = Number(m[2])
  }

  const sekPerEur = ratesAgainstEUR['SEK']
  if (!sekPerEur || sekPerEur <= 0) {
    return NextResponse.json({ error: 'EUR/SEK rate missing from ECB feed' }, { status: 502 })
  }

  // 3. Compute SEK rates and upsert
  const db = createAdminClient()
  const upserts: Array<{ rate_date: string; currency: string; rate_to_sek: number; source: string }> = []

  // EUR → SEK direct from the feed
  upserts.push({ rate_date: rateDate, currency: 'EUR', rate_to_sek: sekPerEur, source: 'ecb' })

  for (const c of CURRENCIES) {
    const eurPerCurrency = ratesAgainstEUR[c]
    if (!eurPerCurrency || eurPerCurrency <= 0) continue
    // ECB gives <currency> per 1 EUR. To get SEK per <currency>:
    //   sek_per_currency = sek_per_eur / currency_per_eur
    const rate = sekPerEur / eurPerCurrency
    upserts.push({ rate_date: rateDate, currency: c, rate_to_sek: Math.round(rate * 10000) / 10000, source: 'ecb' })
  }

  // Also seed SEK = 1.0 on this date (idempotent).
  upserts.push({ rate_date: rateDate, currency: 'SEK', rate_to_sek: 1.0, source: 'system' })

  // Full unique constraint on (rate_date, currency, source) — upsert is safe.
  const { error } = await db
    .from('fx_rates')
    .upsert(upserts, { onConflict: 'rate_date,currency,source' })
  if (error) return NextResponse.json({ error: `upsert failed: ${error.message}` }, { status: 500 })

  return NextResponse.json({
    ok: true,
    rate_date: rateDate,
    inserted:  upserts.length,
    sample:    upserts,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

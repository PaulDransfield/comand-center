// @ts-nocheck
// app/api/admin/diagnose-pk-sales/route.ts
//
// Inspects Personalkollen's raw /sales/ payload so we can tell manual entries
// from POS-synced ones. Use this before changing the extractor — it prints
// the actual schema + bucketed counts so we pick the right fingerprint.
//
//   GET /api/admin/diagnose-pk-sales?business_id=UUID&days=30
//   Auth: x-admin-secret header
//
// Returns:
//   - total sales rows in the window
//   - bucket counts by items.length and payments.length
//   - every top-level key seen across the raw rows
//   - up to 3 samples from each bucket (items=0 = likely manual; items>0 = POS)
//   - for each sample: net-from-items vs gross-from-payments, so we can see
//     how much manual revenue is being dropped by the current extractor

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret }          from '@/lib/admin/check-secret'
import { decrypt }                   from '@/lib/integrations/encryption'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

const PK_BASE = 'https://personalkollen.se/api'

async function fetchAllRaw(endpoint: string, token: string) {
  const results: any[] = []
  let url: string | null = `${PK_BASE}${endpoint}`
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`PK ${res.status} ${res.statusText}`)
    const data = await res.json()
    results.push(...(data.results ?? []))
    url = data.next ?? null
  }
  return results
}

export async function GET(req: NextRequest) {
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const u     = new URL(req.url)
  const bizId = u.searchParams.get('business_id')
  const days  = Math.min(Math.max(Number(u.searchParams.get('days') ?? '30'), 1), 90)
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: biz } = await db.from('businesses').select('id, name, org_id').eq('id', bizId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const { data: integ } = await db
    .from('integrations')
    .select('id, credentials_enc, status')
    .eq('business_id', bizId)
    .eq('provider', 'personalkollen')
    .maybeSingle()
  if (!integ) return NextResponse.json({ error: 'no PK integration on this business' }, { status: 404 })

  // PK stores the API token as a raw decrypted string, not a JSON blob
  // (see lib/sync/engine.ts syncPersonalkollen). Handle both shapes so
  // this diagnostic also works if PK ever moves to { api_key: '...' }.
  let token: string
  try {
    const raw = decrypt(integ.credentials_enc) ?? ''
    const trimmed = raw.trim()
    if (trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed)
      token = parsed.api_key ?? parsed.token ?? ''
    } else {
      token = trimmed
    }
    if (!token) throw new Error('empty token after decrypt')
  } catch (e: any) {
    return NextResponse.json({ error: `credential decrypt failed: ${e.message}` }, { status: 500 })
  }

  const today    = new Date()
  const fromDate = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const toDate   = today.toISOString().slice(0, 10)

  let raw: any[]
  try {
    raw = await fetchAllRaw(`/sales/?sale_time__gte=${fromDate}&sale_time__lte=${toDate}T23:59:59`, token)
  } catch (e: any) {
    return NextResponse.json({ error: `PK fetch failed: ${e.message}` }, { status: 502 })
  }

  // ── Collect every top-level key we see across raw rows ──────────────────
  const allKeys = new Set<string>()
  for (const r of raw) for (const k of Object.keys(r ?? {})) allKeys.add(k)

  // ── Bucket by items.length ──────────────────────────────────────────────
  const byItems: Record<string, number> = { '0': 0, '1-2': 0, '3-5': 0, '6+': 0 }
  const byPayments: Record<string, number> = { '0': 0, '1': 0, '2+': 0 }
  const byMethod: Record<string, number> = {}
  const createdByCount = { withField: 0, withoutField: 0 }

  // Track revenue impact of the items-vs-payments mismatch — this is the
  // bug we suspect: sales with no items get amount=0 in our extractor
  // even when payments[] has the real total.
  let droppedRevenue = 0
  let rowsDropped    = 0
  let totalGrossAll  = 0

  const manualSamples: any[] = []
  const posSamples:    any[] = []

  for (const s of raw) {
    const itemsLen    = Array.isArray(s.items)    ? s.items.length    : 0
    const paymentsLen = Array.isArray(s.payments) ? s.payments.length : 0

    if      (itemsLen === 0)  byItems['0']++
    else if (itemsLen <= 2)   byItems['1-2']++
    else if (itemsLen <= 5)   byItems['3-5']++
    else                      byItems['6+']++

    if      (paymentsLen === 0) byPayments['0']++
    else if (paymentsLen === 1) byPayments['1']++
    else                        byPayments['2+']++

    for (const p of (s.payments ?? [])) {
      const m = p.method?.name ?? p.payment_type ?? '(unknown)'
      byMethod[m] = (byMethod[m] ?? 0) + 1
    }

    if ('created_by' in s) createdByCount.withField++
    else                   createdByCount.withoutField++

    // Revenue reconciliation
    const netFromItems = (s.items ?? []).reduce((sum: number, i: any) =>
      sum + (parseFloat(i.amount ?? 0) * parseFloat(i.price_per_unit ?? 0)), 0)
    const grossFromPay = (s.payments ?? []).reduce((sum: number, p: any) =>
      sum + parseFloat(p.amount ?? 0), 0)
    totalGrossAll += grossFromPay

    if (netFromItems === 0 && grossFromPay > 0) {
      droppedRevenue += grossFromPay
      rowsDropped++
    }

    // Collect samples from each bucket. Trim noise but keep the full shape.
    const sample = {
      uid:            s.uid,
      sale_time:      s.sale_time,
      workplace:      s.workplace,
      items_length:   itemsLen,
      payments_length: paymentsLen,
      items_sample:   (s.items ?? []).slice(0, 2),
      payments:       s.payments ?? [],
      tip:            s.tip ?? null,
      number_of_guests: s.number_of_guests ?? null,
      is_take_away:   s.is_take_away ?? null,
      created_by:     s.created_by ?? null,
      net_from_items: Math.round(netFromItems * 100) / 100,
      gross_from_payments: Math.round(grossFromPay * 100) / 100,
      // All other top-level fields that aren't already captured above
      _other_keys: Object.keys(s).filter(k => !['uid','sale_time','workplace','items','payments','tip','number_of_guests','is_take_away','created_by','url'].includes(k)),
    }
    if (itemsLen === 0 && manualSamples.length < 3) manualSamples.push(sample)
    if (itemsLen > 0  && posSamples.length    < 3) posSamples.push(sample)
  }

  return NextResponse.json({
    business:   biz.name,
    date_range: { from: fromDate, to: toDate, days },
    total_sales: raw.length,
    top_level_fields_seen: [...allKeys].sort(),
    by_items_length: byItems,
    by_payments_length: byPayments,
    by_payment_method:  byMethod,
    created_by_presence: createdByCount,
    revenue_reconciliation: {
      total_gross_from_payments: Math.round(totalGrossAll),
      rows_with_zero_items_nonzero_payment: rowsDropped,
      revenue_potentially_dropped_kr: Math.round(droppedRevenue),
      comment: rowsDropped > 0
        ? 'These rows have a payment total but no line items. Current extractor computes amount=0 for them → dropped in revenue_logs.'
        : 'No manual-looking (zero-items, non-zero payment) rows found in this window.',
    },
    samples: {
      likely_manual_entries: manualSamples,
      pos_entries:           posSamples,
    },
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}

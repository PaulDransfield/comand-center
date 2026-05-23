// app/api/inventory/needs-review/route.ts
//
// GET — bulk-review queue. Pulls every supplier_invoice_lines row with
// match_status='needs_review' for a business, normalises the description
// in JS, and groups by (supplier_fortnox_number, normalised_description,
// unit). Returns one row per group sorted by total_kr desc so the owner
// sees the biggest catalogue holes first.
//
// This is the seed surface for the catalogue. The matcher only re-matches
// against EXISTING products — it never creates products. Until the owner
// approves groups here (via /api/inventory/needs-review/approve), the
// catalogue stays empty.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { normaliseDescription } from '@/lib/inventory/normalise'
import { categoryForBasAccount, type InventoryCategory } from '@/lib/inventory/categories'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ReviewGroup {
  group_key:                string  // base64url(supplier|normalised|unit) — opaque, stable
  supplier_fortnox_number:  string
  supplier_name:            string | null
  suggested_name:           string  // cleaned-up raw_description
  sample_raw_description:   string
  unit:                     string | null
  line_count:               number
  invoice_count:            number
  total_kr:                 number
  latest_price:             number | null
  min_price:                number | null
  max_price:                number | null
  most_common_account:      string | null
  suggested_category:       InventoryCategory | 'other'
  latest_invoice_date:      string | null
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Paginate through every needs_review row. Worst case for a fresh
  // backfill is ~5 k rows — fine for one pass.
  const lines: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('supplier_invoice_lines')
      .select('id, supplier_fortnox_number, supplier_name_snapshot, raw_description, unit, price_per_unit, total_excl_vat, account_number, fortnox_invoice_number, invoice_date')
      .eq('business_id', businessId)
      .eq('match_status', 'needs_review')
      .order('invoice_date', { ascending: false })
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    lines.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (from > 20_000) break
  }

  // Group in JS — Postgres can't run our JS normalisation function.
  // Key = normalisedDesc | unit-canonical | supplier_fortnox_number.
  // We keep the SUPPLIER bucket separate (matches the matcher's step 2:
  // unique (business, supplier, normalised_desc, unit)) — same name
  // from two suppliers becomes two groups so owner can decide if they're
  // really the same SKU later (cross-supplier matcher will link them).
  type GroupAccum = {
    lines:              any[]
    invoiceNumbers:     Set<string>
    accountCounts:      Record<string, number>
    supplier_name:      string | null
    sample_raw:         string
    sample_normalised:  string
  }
  const groups = new Map<string, GroupAccum>()

  for (const l of lines) {
    const normalised = normaliseDescription(l.raw_description)
    if (!normalised) continue   // empty/garbage — owner can't act on it anyway
    const unit = (l.unit ?? '').trim().toLowerCase()
    const key  = `${l.supplier_fortnox_number}\x1f${normalised}\x1f${unit}`
    let g = groups.get(key)
    if (!g) {
      g = {
        lines:             [],
        invoiceNumbers:    new Set(),
        accountCounts:     {},
        supplier_name:     l.supplier_name_snapshot ?? null,
        sample_raw:        l.raw_description ?? '',
        sample_normalised: normalised,
      }
      groups.set(key, g)
    }
    g.lines.push(l)
    if (l.fortnox_invoice_number) g.invoiceNumbers.add(l.fortnox_invoice_number)
    if (l.account_number) {
      const k = String(l.account_number).trim()
      g.accountCounts[k] = (g.accountCounts[k] ?? 0) + 1
    }
    if (!g.supplier_name && l.supplier_name_snapshot) g.supplier_name = l.supplier_name_snapshot
  }

  // Build the response rows.
  const out: ReviewGroup[] = []
  for (const [key, g] of groups) {
    const prices = g.lines.map(l => Number(l.price_per_unit)).filter(n => Number.isFinite(n) && n > 0)
    const latest = g.lines.slice().sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? ''))[0]
    const totalKr = g.lines.reduce((s, l) => s + (Number(l.total_excl_vat) || 0), 0)
    const mostCommonAccount = Object.entries(g.accountCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const suggestedCategory =
      categoryForBasAccount(mostCommonAccount) ??
      'other'
    out.push({
      group_key:               Buffer.from(key, 'utf-8').toString('base64url'),
      supplier_fortnox_number: g.lines[0].supplier_fortnox_number,
      supplier_name:           g.supplier_name,
      suggested_name:          tidyName(g.sample_raw),
      sample_raw_description:  g.sample_raw,
      unit:                    g.lines[0].unit ?? null,
      line_count:              g.lines.length,
      invoice_count:           g.invoiceNumbers.size,
      total_kr:                Math.round(totalKr * 100) / 100,
      latest_price:            latest?.price_per_unit != null ? Number(latest.price_per_unit) : null,
      min_price:               prices.length ? Math.min(...prices) : null,
      max_price:               prices.length ? Math.max(...prices) : null,
      most_common_account:     mostCommonAccount,
      suggested_category:      suggestedCategory,
      latest_invoice_date:     latest?.invoice_date ?? null,
    })
  }

  out.sort((a, b) => b.total_kr - a.total_kr)

  // Counts per suggested category for the filter chips
  const counts: Record<string, number> = { all: out.length }
  for (const g of out) counts[g.suggested_category] = (counts[g.suggested_category] ?? 0) + 1

  return NextResponse.json({
    counts,
    groups: out,
    total_lines:    lines.length,
    total_groups:   out.length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// Cleaner for the suggested product name. Removes the supplier's
// auto-attached SKU codes, trailing unit specs, and weird casing.
// Leaves the result still readable; owner can rename in-place anyway.
function tidyName(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = String(raw).trim()
  // Strip leading SKU-like prefixes "12345 " or "ART-9988 "
  s = s.replace(/^[A-Z0-9-]{4,}\s+/i, '')
  // Title-case the first letter of each word, but only if input was ALL CAPS
  if (/^[A-ZÅÄÖ0-9\s\W]+$/.test(s) && s.length > 4) {
    s = s.toLowerCase().replace(/\b([a-zåäö])/g, m => m.toUpperCase())
  }
  return s.trim()
}

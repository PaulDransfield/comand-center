// app/api/cron/invoice-reconciliation/route.ts
//
// Weekly reconciliation between user-uploaded supplier invoices (/invoices)
// and Fortnox P&L line items (tracker_line_items).  Two-sided check:
//   - Invoices with no matching Fortnox line   → possibly missing from bookkeeping
//   - Fortnox line with no matching invoice     → possibly missing documentation
//
// Matching heuristic:
//   1. Same business + same period (year, month of invoice_date / period_month).
//   2. Vendor name fuzzy-matches any Fortnox label (label_sv contains vendor,
//      or vendor contains label_sv, case-insensitive, trimmed).
//   3. Amount within ±5% tolerance (invoice stored ex-VAT; Fortnox rows are ex-VAT).
//
// Writes findings into reconciliation_findings (a fresh table per run;
// dismissed_at nulls on replace).  Rendered as an AttentionPanel on
// /invoices and /overheads.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret } from '@/lib/admin/check-secret'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const AMOUNT_TOLERANCE = 0.05  // ±5%

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ')
}

function fuzzyMatch(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b)
  if (!na || !nb) return false
  // Either-side substring of ≥4 chars lines up most Swedish supplier names.
  if (na.length >= 4 && nb.includes(na)) return true
  if (nb.length >= 4 && na.includes(nb)) return true
  return false
}

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const db = createAdminClient()
  const windowYear = new Date().getFullYear() - 1   // last 12 months of data

  // Pull invoices + line items in one pass — the reconciliation is per-org,
  // per-business, so we group in memory.
  const [invRes, liRes] = await Promise.all([
    db.from('invoices')
      .select('id, org_id, business_id, vendor, amount, vat_amount, invoice_date, status, category')
      .gte('invoice_date', `${windowYear}-01-01`)
      .limit(10_000),
    db.from('tracker_line_items')
      .select('id, org_id, business_id, period_year, period_month, label_sv, category, subcategory, amount')
      .eq('category', 'other_cost')
      .gte('period_year', windowYear)
      .limit(20_000),
  ])

  const invoices = invRes.data ?? []
  const lines    = liRes.data  ?? []

  // Index line items by (org, biz, year, month)
  const linesByPeriod = new Map<string, any[]>()
  for (const l of lines) {
    const k = `${l.org_id}|${l.business_id}|${l.period_year}|${l.period_month}`
    if (!linesByPeriod.has(k)) linesByPeriod.set(k, [])
    linesByPeriod.get(k)!.push(l)
  }

  // Match each invoice to a candidate line.
  const matches:      any[] = []
  const unmatchedInv: any[] = []
  const matchedLineIds = new Set<string>()

  for (const inv of invoices) {
    if (!inv.invoice_date) continue
    const d = new Date(inv.invoice_date)
    const k = `${inv.org_id}|${inv.business_id}|${d.getFullYear()}|${d.getMonth() + 1}`
    const candidates = linesByPeriod.get(k) ?? []
    const match = candidates.find(l => {
      if (!fuzzyMatch(inv.vendor, l.label_sv)) return false
      const invNet = Number(inv.amount)
      const lineAmt = Number(l.amount)
      if (lineAmt <= 0) return false
      const diff = Math.abs(invNet - lineAmt) / Math.max(invNet, lineAmt)
      return diff <= AMOUNT_TOLERANCE
    })
    if (match) {
      matches.push({ invoice_id: inv.id, line_id: match.id })
      matchedLineIds.add(match.id)
    } else {
      unmatchedInv.push(inv)
    }
  }

  // Lines with no invoice backing them — only where we'd expect documentation
  // (rent, utilities, large software) so we don't spam on every 10-kr stamp.
  const DOC_EXPECTED = new Set(['rent', 'utilities', 'software', 'accounting', 'audit', 'consulting', 'insurance', 'telecom', 'marketing', 'repairs'])
  const unmatchedLines = lines.filter(l => {
    if (matchedLineIds.has(l.id)) return false
    if (Number(l.amount) < 500) return false        // ignore tiny lines
    return DOC_EXPECTED.has(l.subcategory ?? '')
  })

  // Upsert findings — dismiss-then-insert so the UI always sees the latest.
  const nowIso = new Date().toISOString()
  const findings: any[] = []

  for (const inv of unmatchedInv) {
    findings.push({
      org_id:      inv.org_id,
      business_id: inv.business_id,
      kind:        'invoice_not_in_fortnox',
      tone:        'warning',
      entity:      inv.vendor,
      message:     `Invoice ${inv.vendor} (${Math.round(Number(inv.amount))} kr) not found in Fortnox P&L for ${inv.invoice_date?.slice(0, 7)}.`,
      evidence:    { invoice_id: inv.id, vendor: inv.vendor, amount: inv.amount, date: inv.invoice_date },
      generated_at: nowIso,
    })
  }
  for (const l of unmatchedLines) {
    findings.push({
      org_id:      l.org_id,
      business_id: l.business_id,
      kind:        'line_without_invoice',
      tone:        'warning',
      entity:      l.label_sv,
      message:     `${l.label_sv} (${Math.round(Number(l.amount))} kr) has no matching invoice uploaded for ${l.period_year}-${String(l.period_month).padStart(2, '0')}.`,
      evidence:    { line_id: l.id, label: l.label_sv, amount: l.amount, period: { year: l.period_year, month: l.period_month } },
      generated_at: nowIso,
    })
  }

  // Clear previous active findings for reconciliation kinds + insert fresh.
  try {
    await db.from('reconciliation_findings')
      .update({ dismissed_at: nowIso })
      .in('kind', ['invoice_not_in_fortnox', 'line_without_invoice'])
      .is('dismissed_at', null)
  } catch { /* table may not exist yet — handled below */ }

  let inserted = 0
  if (findings.length) {
    const { error } = await db.from('reconciliation_findings').insert(findings)
    if (error && (error.code === '42P01' || error.code === 'PGRST205')) {
      // Table missing — return a clear instruction instead of silently dropping.
      return NextResponse.json({
        error: 'reconciliation_findings table not found — run FORTNOX-FOLLOWUP-MIGRATION.sql',
        matches: matches.length,
        would_insert: findings.length,
      }, { status: 500 })
    }
    if (!error) inserted = findings.length
  }

  return NextResponse.json({
    matches: matches.length,
    unmatched_invoices: unmatchedInv.length,
    unmatched_lines:    unmatchedLines.length,
    inserted,
  })
}

export async function GET(req: NextRequest) { return POST(req) }

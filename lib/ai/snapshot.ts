// lib/ai/snapshot.ts
//
// Compact "state of the business" snapshot for AI system prompts.
//
// Phase 1 of the AI-awareness work: tells every LLM surface — /ask,
// budget agents, tracker narrative, crons — exactly what data exists
// for this customer at this moment, without the LLM having to ask
// for it. The snapshot becomes the LEFT side of every conversation:
// before the user's question, before any keyword enrichment, before
// any retrieved context, the model sees:
//
//   - Setup health (which of 12 checks pass, which fail)
//   - Fiscal year + voucher freshness (how up-to-date the books are)
//   - Accounts chart loaded (how many accounts the customer uses)
//   - Cash position (sum of 1900-1989 from per-account v2 cache)
//   - Recent tracker_data periods (what closed months we have)
//   - Inventory state (catalogue size + PDF extraction progress)
//
// Hard rule: cache-first reads only. No fetchFinancialYears, no
// fetchBankAccountBalances, no Fortnox calls. The snapshot must be
// computable from Postgres alone — typical wall-clock < 500 ms even
// for a fully-loaded customer. If a value isn't cached, the snapshot
// says so honestly rather than blocking.
//
// Phase 2 (separate commits) adds TOOLS the LLM can call to drill into
// balance sheet, momsrapport, voucher detail, supplier invoices, and
// inventory items. The snapshot tells the LLM these tools exist.

type Db = any

const NUMBER_FMT_SV: Intl.NumberFormat = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 })
const DATE_FMT_ISO = (d: Date) => d.toISOString().slice(0, 10)

function fmtKr(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${NUMBER_FMT_SV.format(Math.round(Number(n)))} kr`
}

export interface SnapshotOptions {
  /** If true, include the inventory section (catalogue + PDF extraction). */
  inventory?: boolean
  /** If true, include the tool catalogue at the end (Phase 2 tool list). */
  toolCatalogue?: boolean
}

/**
 * Build the compact business-state snapshot. Pure read-mostly compute.
 * Soft-fails on any individual section so a single bad query doesn't
 * break the whole snapshot.
 */
export async function buildBusinessSnapshot(
  db:         Db,
  orgId:      string,
  businessId: string,
  opts:       SnapshotOptions = {},
): Promise<string> {
  const lines: string[] = []
  lines.push('=== BUSINESS STATE (cache-derived, current as of this request) ===')

  // ── 1. Business identity ─────────────────────────────────────────
  try {
    const { data: biz } = await db
      .from('businesses')
      .select('name, legal_name, legal_city, org_number, country, vat_filing_cadence, setup_health_summary, setup_health_updated_at, business_stage, opening_days')
      .eq('id', businessId)
      .maybeSingle()
    if (biz) {
      const display = biz.legal_name && biz.legal_name !== biz.name
        ? `${biz.legal_name} (trades as ${biz.name})`
        : (biz.legal_name ?? biz.name)
      lines.push(`Business:        ${display}${biz.org_number ? ` · ${biz.org_number}` : ''}${biz.legal_city ? ` · ${biz.legal_city}` : ''}${biz.country ? ` · ${biz.country}` : ''}`)
      // Business stage — load-bearing for any predictive surface. A 'new'
      // business has <12 months of operating history; the prior-year
      // anchor rule is invalid and MUST be skipped. AI surfaces reading
      // this snapshot should branch on stage when generating forecasts /
      // budgets / cost projections.
      if (biz.business_stage) {
        const stageHint = biz.business_stage === 'new'
          ? 'no prior-year actuals available — do NOT anchor forecasts on last-year data'
          : biz.business_stage === 'established_1y'
            ? 'has one prior year of actuals (anchor cautiously)'
            : biz.business_stage === 'established_3y'
              ? 'has 3+ years of actuals (full prior-year anchor available)'
              : ''
        lines.push(`Business stage:  ${biz.business_stage}${stageHint ? ` — ${stageHint}` : ''}`)
      }
      // Opening days drive the scheduling-AI's day-of-week loop and
      // help the forecast engine skip closed days. JSONB shape:
      // { mon: true, tue: true, … }
      const od = biz.opening_days as any | null
      if (od && typeof od === 'object') {
        const open = ['mon','tue','wed','thu','fri','sat','sun'].filter(d => od[d] === true)
        if (open.length > 0 && open.length < 7) {
          lines.push(`Opening days:    ${open.join(', ')} (others closed — skip in forecasts/scheduling)`)
        }
      }
      if (biz.vat_filing_cadence) {
        const cadenceSv = biz.vat_filing_cadence === 'monthly' ? 'månadsvis' :
                          biz.vat_filing_cadence === 'quarterly' ? 'kvartalsvis' : 'årsvis'
        lines.push(`VAT cadence:     ${cadenceSv} (drives momsrapport scope)`)
      } else {
        lines.push(`VAT cadence:     not set (defaults to quarterly)`)
      }
      // Setup health summary
      const hs = biz.setup_health_summary as any | null
      if (hs?.counts) {
        const c = hs.counts
        const total = (c.ok ?? 0) + (c.warn ?? 0) + (c.fail ?? 0) + (c.pending ?? 0)
        const failing = (hs.failing_checks ?? []).map((f: any) => f.label).slice(0, 3).join(', ')
        const ageMin = biz.setup_health_updated_at
          ? Math.floor((Date.now() - new Date(biz.setup_health_updated_at).getTime()) / 60_000)
          : null
        const ageStr = ageMin == null ? 'unknown' :
                       ageMin < 60 ? `${ageMin} min ago` :
                       ageMin < 1440 ? `${Math.floor(ageMin / 60)} h ago` :
                       `${Math.floor(ageMin / 1440)} d ago`
        lines.push(`Setup health:    ${c.ok ?? 0}/${total} checks ok · overall=${hs.overall ?? '?'} · last eval ${ageStr}`)
        if (failing) lines.push(`                 Pending/issues: ${failing}${(hs.failing_checks ?? []).length > 3 ? '…' : ''}`)
      } else {
        lines.push(`Setup health:    no readiness summary yet (run /api/integrations/fortnox/readiness)`)
      }
    } else {
      lines.push(`Business:        not found in this org (business_id=${businessId})`)
    }
  } catch (e: any) {
    lines.push(`Business:        (lookup failed: ${String(e?.message ?? e).slice(0, 60)})`)
  }

  // ── 2. Fiscal year + voucher freshness ───────────────────────────
  try {
    // Most-recent accounts_list cache row tells us FY + total chart size.
    const { data: alRow } = await db
      .from('overhead_drilldown_cache')
      .select('payload, fetched_at')
      .eq('business_id', businessId)
      .eq('period_month', 0)
      .like('category', '__accounts_list_fy%')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (alRow?.payload) {
      const p = alRow.payload as any
      lines.push(`Fiscal year:     ${p.fiscal_year_from} → ${p.fiscal_year_to} (current)`)
      lines.push(`Account chart:   ${p.total_accounts ?? '?'} accounts in customer's Fortnox chart`)
    } else {
      lines.push(`Fiscal year:     unknown (accounts list not yet cached)`)
    }
  } catch { /* skip */ }

  try {
    const { count: voucherCount } = await db
      .from('fortnox_vouchers_cache')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
    const { data: latestRow } = await db
      .from('fortnox_vouchers_cache')
      .select('transaction_date')
      .eq('business_id', businessId)
      .order('transaction_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    const latest = latestRow?.transaction_date
    if (latest) {
      const ageDays = Math.floor((Date.now() - new Date(latest).getTime()) / (24 * 60 * 60 * 1000))
      const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? 'yesterday' : `${ageDays} d ago`
      lines.push(`Books freshness: latest voucher ${latest} (${ageStr}) · ${NUMBER_FMT_SV.format(voucherCount ?? 0)} vouchers cached`)
    } else {
      lines.push(`Books freshness: no vouchers cached yet`)
    }
  } catch { /* skip */ }

  // ── 3. Cash position (per-account v2 cache, 1900-1989) ──────────
  try {
    const { data: bbRows } = await db
      .from('overhead_drilldown_cache')
      .select('payload, fetched_at, category')
      .eq('business_id', businessId)
      .eq('period_month', 0)
      .like('category', '__bank_balance_v2_%')
      .order('fetched_at', { ascending: false })
    let sum = 0
    let count = 0
    let largestAcc = 0
    let largestVal = 0
    const seen = new Set<number>()
    for (const r of bbRows ?? []) {
      const p = (r as any).payload
      if (!p || typeof p.account !== 'number') continue
      if (seen.has(p.account)) continue
      seen.add(p.account)
      if (p.account < 1900 || p.account > 1989) continue
      const cur = Number(p.current_balance ?? 0)
      sum += cur
      count++
      if (Math.abs(cur) > Math.abs(largestVal)) {
        largestVal = cur
        largestAcc = p.account
      }
    }
    if (count > 0) {
      lines.push(`Cash position:   ${fmtKr(sum)} (sum of ${count} accounts in 1900-1989 range)`)
      if (largestAcc) lines.push(`                 Largest: account ${largestAcc} = ${fmtKr(largestVal)}`)
    } else {
      lines.push(`Cash position:   not yet cached`)
    }
  } catch { /* skip */ }

  // ── 4. Closed-month tracker_data — what P&L months we have ──────
  try {
    const { count: closedCount } = await db
      .from('tracker_data')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .or('is_provisional.is.null,is_provisional.eq.false')
    const { data: latest } = await db
      .from('tracker_data')
      .select('period_year, period_month, revenue, net_profit, margin_pct')
      .eq('business_id', businessId)
      .or('is_provisional.is.null,is_provisional.eq.false')
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latest) {
      lines.push(`Closed P&L:      ${closedCount ?? 0} months on file · latest ${latest.period_year}-${String(latest.period_month).padStart(2, '0')}`)
      lines.push(`                 Revenue ${fmtKr(latest.revenue)} · Net ${fmtKr(latest.net_profit)} · Margin ${latest.margin_pct != null ? `${Number(latest.margin_pct).toFixed(1)} %` : '—'}`)
    } else {
      lines.push(`Closed P&L:      0 months — backfill hasn't populated tracker_data yet`)
    }
  } catch { /* skip */ }

  // ── 5. Inventory (optional, default on) ──────────────────────────
  if (opts.inventory !== false) {
    try {
      const [productsCount, aliasesCount, linesCount, extByStatus] = await Promise.all([
        db.from('products').select('*', { count: 'exact', head: true }).eq('business_id', businessId),
        db.from('product_aliases').select('*', { count: 'exact', head: true }).eq('business_id', businessId),
        db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).eq('business_id', businessId),
        db.from('invoice_pdf_extractions').select('status').eq('business_id', businessId).range(0, 9999),
      ])
      const exStatusCounts = { extracted: 0, pending: 0, extracting: 0, no_pdf: 0, needs_review: 0, failed: 0 } as Record<string, number>
      for (const r of (extByStatus.data ?? [])) exStatusCounts[(r as any).status] = (exStatusCounts[(r as any).status] ?? 0) + 1
      const totalExt = Object.values(exStatusCounts).reduce((s, n) => s + n, 0)
      lines.push(`Inventory:       ${productsCount.count ?? 0} products · ${aliasesCount.count ?? 0} aliases · ${linesCount.count ?? 0} supplier-invoice lines`)
      if (totalExt > 0) {
        lines.push(`                 PDF extractions: ${exStatusCounts.extracted}/${totalExt} done · ${exStatusCounts.pending} pending · ${exStatusCounts.needs_review} need review · ${exStatusCounts.no_pdf} no-pdf`)
      }
    } catch { /* skip */ }
  }

  // ── 6. Tool catalogue (Phase 2 hook) ─────────────────────────────
  if (opts.toolCatalogue) {
    lines.push('')
    lines.push('AVAILABLE TOOLS (call these for detail; never invent numbers):')
    lines.push('  get_balance_sheet(year, month)       — full BS per period')
    lines.push('  get_momsrapport(year, month)         — SKV 4700 boxes')
    lines.push('  search_vouchers({...})               — filter by date/account/supplier')
    lines.push('  search_supplier_invoices({...})      — Fortnox supplier invoice feed')
    lines.push('  get_account_balance(number)          — single Fortnox account')
    lines.push('  search_inventory_products(query)     — catalogue product/alias lookup')
    lines.push('  get_invoice_lines(invoice_number)    — line items for one invoice')
    lines.push('  get_inventory_summary()              — catalogue + PDF-extraction state')
    lines.push('  get_product_price_history(product_id)— full price history per product')
  }

  lines.push('=== END BUSINESS STATE ===')
  return lines.join('\n')
}

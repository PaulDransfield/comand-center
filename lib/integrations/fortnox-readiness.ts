// lib/integrations/fortnox-readiness.ts
//
// Day-1 readiness validator for a Fortnox-connected business. Runs 10
// checks against the data we've already cached (accounts list, voucher
// cache, tracker_data) and returns structured findings. Fast — typical
// call is < 3 s because every validator reads from cache.
//
// Each check returns:
//   status: 'ok' | 'warn' | 'fail' | 'pending'
//     - ok      → green, customer ready for this dimension
//     - warn    → yellow, cosmetic / small issue, surfaceable
//     - fail    → red, blocks confident use of the product
//     - pending → check itself is in-flight (e.g. voucher cache still warming)
//   detail: human-readable summary
//   evidence: structured supporting data for the UI to render
//
// The readiness ENDPOINT runs all 10 checks in parallel and returns
// the aggregate. The UI polls every 3 s so the picture progresses
// naturally as background workers (cache warm, backfill) complete.

import { fetchAccountsList }           from '@/lib/fortnox/api/accounts-list'
import { fetchFinancialYears }         from '@/lib/fortnox/api/financial-years'
import { getFreshFortnoxAccessToken }  from '@/lib/fortnox/api/auth'
import { computeBalanceSheet }         from '@/lib/revisor/balance-sheet'
import {
  OUTPUT_VAT_ACCOUNT_TO_BOX,
  INPUT_VAT_ACCOUNTS,
  classifyRevenueAccount,
}                                      from '@/lib/revisor/momsrapport'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'pending'

export interface ReadinessCheck {
  key:       string                          // stable id (identity, fiscal_year, …)
  label:     string                          // UI title in Swedish
  status:    CheckStatus
  detail:    string                          // 1-line summary
  evidence?: Record<string, unknown>         // structured data for drilling
}

export interface ReadinessResult {
  business_id:  string
  overall:      CheckStatus                  // worst-of across checks (pending acts as warn)
  ready_to_use: boolean                      // true if no 'fail' checks
  checks:       ReadinessCheck[]
  duration_ms:  number
}

const SECOND = 1000

export async function evaluateFortnoxReadiness(
  db:         any,
  orgId:      string,
  businessId: string,
): Promise<ReadinessResult> {
  const t0 = Date.now()

  // Pull the businesses row once — used by identity + revenue checks.
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, legal_name, legal_city, org_number, country, vat_filing_cadence, org_id')
    .eq('id', businessId)
    .maybeSingle()

  // Get a fresh access token. If this fails, every Fortnox-side check
  // fails uniformly. Cache the token across the parallel checks.
  let accessToken: string | null = null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, orgId, businessId)
  } catch { /* leave null */ }

  // Run all checks in parallel — they're read-mostly and independent.
  const [
    identity,
    fiscalYear,
    accountsChart,
    voucherCache,
    openingBalance,
    balanceSheet,
    vatCoverage,
    revenueClass,
    backfill,
    freshness,
    multiBusiness,
    vatCadence,
  ] = await Promise.all([
    checkIdentity(biz),
    checkFiscalYear(accessToken),
    checkAccountChart(db, orgId, businessId, accessToken),
    checkVoucherCache(db, businessId, accessToken),
    checkOpeningBalanceSum(db, orgId, businessId, accessToken),
    checkBalanceSheetSelfCheck(db, orgId, businessId),
    checkVatCoverage(db, businessId, accessToken),
    checkRevenueClassification(db, businessId, accessToken),
    checkBackfillProgress(db, businessId),
    checkBookkeepingFreshness(db, businessId),
    checkMultiBusinessConnections(db, orgId, businessId),
    checkVatFilingCadence(biz),
  ])

  const checks = [identity, fiscalYear, accountsChart, voucherCache, openingBalance,
    balanceSheet, vatCoverage, revenueClass, backfill, freshness, multiBusiness, vatCadence]

  const hasFail    = checks.some(c => c.status === 'fail')
  const hasWarn    = checks.some(c => c.status === 'warn')
  const hasPending = checks.some(c => c.status === 'pending')
  const overall: CheckStatus = hasFail ? 'fail' : hasPending ? 'pending' : hasWarn ? 'warn' : 'ok'

  const result: ReadinessResult = {
    business_id:  businessId,
    overall,
    ready_to_use: !hasFail,
    checks,
    duration_ms:  Date.now() - t0,
  }

  // Persist a compact summary back to businesses so the dashboard widget
  // can render instantly without paying the 3-5 s cost of re-running the
  // full validator on every page load. Best-effort write — failure to
  // persist doesn't fail the request.
  try {
    const counts = { ok: 0, warn: 0, fail: 0, pending: 0 } as Record<CheckStatus, number>
    for (const c of checks) counts[c.status]++
    const failing = checks
      .filter(c => c.status === 'fail' || c.status === 'warn')
      .map(c => ({ key: c.key, label: c.label, status: c.status, detail: c.detail }))
    await db
      .from('businesses')
      .update({
        setup_health_summary: {
          overall,
          ready_to_use: !hasFail,
          counts,
          failing_checks: failing,
          evaluated_at: new Date().toISOString(),
        },
        setup_health_updated_at: new Date().toISOString(),
      })
      .eq('id', businessId)
  } catch { /* swallow */ }

  return result
}

// ─── 1. Identity ─────────────────────────────────────────────────────

async function checkIdentity(biz: any): Promise<ReadinessCheck> {
  if (!biz) {
    return { key: 'identity', label: 'Företagsidentitet', status: 'fail',
             detail: 'Verksamheten kunde inte hittas.' }
  }
  const missing: string[] = []
  if (!biz.legal_name) missing.push('legal name')
  if (!biz.legal_city) missing.push('city')
  if (!biz.org_number) missing.push('org-nr')

  if (missing.length === 0) {
    return {
      key:    'identity',
      label:  'Företagsidentitet',
      status: 'ok',
      detail: `${biz.legal_name} · ${biz.org_number} · ${biz.legal_city}`,
      evidence: {
        legal_name: biz.legal_name,
        org_number: biz.org_number,
        legal_city: biz.legal_city,
        trading_name: biz.legal_name !== biz.name ? biz.name : null,
      },
    }
  }

  // Identity sync runs on OAuth — anything missing means the sync hasn't
  // landed yet OR Fortnox doesn't expose the field.
  const allMissing = missing.length === 3
  return {
    key:    'identity',
    label:  'Företagsidentitet',
    status: allMissing ? 'pending' : 'warn',
    detail: `Saknar: ${missing.join(', ')}.${allMissing ? ' Sker automatiskt strax.' : ''}`,
    evidence: { missing },
  }
}

// ─── 2. Fiscal year ───────────────────────────────────────────────────

async function checkFiscalYear(accessToken: string | null): Promise<ReadinessCheck> {
  if (!accessToken) {
    return { key: 'fiscal_year', label: 'Räkenskapsår', status: 'fail',
             detail: 'Kunde inte autentisera mot Fortnox.' }
  }
  try {
    const { years } = await fetchFinancialYears(accessToken)
    if (!years || years.length === 0) {
      return { key: 'fiscal_year', label: 'Räkenskapsår', status: 'fail',
               detail: 'Inget räkenskapsår är upplagt i Fortnox.' }
    }
    const today = new Date().toISOString().slice(0, 10)
    const current = years.find(y => y.FromDate <= today && y.ToDate >= today)
    if (!current) {
      return { key: 'fiscal_year', label: 'Räkenskapsår', status: 'warn',
               detail: `Inget pågående räkenskapsår innehåller idag. Senast registrerat: ${years[0].FromDate} – ${years[0].ToDate}.`,
               evidence: { years_count: years.length, latest: years[0] } }
    }
    return {
      key:    'fiscal_year',
      label:  'Räkenskapsår',
      status: 'ok',
      detail: `${current.FromDate} – ${current.ToDate}`,
      evidence: { fy_id: current.Id, from: current.FromDate, to: current.ToDate, total_years: years.length },
    }
  } catch (e: any) {
    return { key: 'fiscal_year', label: 'Räkenskapsår', status: 'fail',
             detail: `Fortnox /financialyears misslyckades: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 3. Account chart ─────────────────────────────────────────────────

async function checkAccountChart(
  db: any, orgId: string, businessId: string, accessToken: string | null,
): Promise<ReadinessCheck> {
  if (!accessToken) {
    return { key: 'account_chart', label: 'Kontoplan', status: 'pending',
             detail: 'Väntar på Fortnox-autentisering.' }
  }
  try {
    const r = await fetchAccountsList(db, orgId, businessId, accessToken)
    const count = r.total_accounts
    if (count === 0) {
      return { key: 'account_chart', label: 'Kontoplan', status: 'fail',
               detail: 'Inga konton kunde hämtas från Fortnox.' }
    }
    if (count < 50) {
      return { key: 'account_chart', label: 'Kontoplan', status: 'warn',
               detail: `Endast ${count} konton hittade — kontoplanen verkar minimal. Kontrollera Fortnox-uppsättningen.`,
               evidence: { count, from_cache: r.from_cache } }
    }
    return {
      key:    'account_chart',
      label:  'Kontoplan',
      status: 'ok',
      detail: `${count} konton inlästa${r.from_cache ? ' (från cache)' : ''}.`,
      evidence: { count, from_cache: r.from_cache },
    }
  } catch (e: any) {
    return { key: 'account_chart', label: 'Kontoplan', status: 'fail',
             detail: `Kunde inte läsa kontoplan: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 4. Voucher cache coverage ────────────────────────────────────────

async function checkVoucherCache(
  db: any, businessId: string, accessToken: string | null,
): Promise<ReadinessCheck> {
  if (!accessToken) {
    return { key: 'voucher_cache', label: 'Verifikationscache', status: 'pending',
             detail: 'Väntar på Fortnox-autentisering.' }
  }
  try {
    const { years } = await fetchFinancialYears(accessToken)
    const today = new Date().toISOString().slice(0, 10)
    const current = years.find(y => y.FromDate <= today && y.ToDate >= today)
    if (!current) {
      return { key: 'voucher_cache', label: 'Verifikationscache', status: 'pending',
               detail: 'Räkenskapsår saknas.' }
    }

    const months = monthsInRange(current.FromDate, today)
    const cached: string[] = []
    const missing: string[] = []
    for (const { y, m } of months) {
      const { count } = await db
        .from('fortnox_vouchers_cache')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', businessId)
        .eq('period_year',  y)
        .eq('period_month', m)
      const key = `${y}-${String(m).padStart(2, '0')}`
      if ((count ?? 0) > 0) cached.push(key); else missing.push(key)
    }

    if (missing.length === 0) {
      return {
        key: 'voucher_cache', label: 'Verifikationscache', status: 'ok',
        detail: `Alla ${months.length} månader cachelagrade.`,
        evidence: { months_total: months.length, months_cached: cached.length },
      }
    }
    if (missing.length <= 2) {
      return {
        key: 'voucher_cache', label: 'Verifikationscache', status: 'pending',
        detail: `${missing.length} av ${months.length} månader laddas (bakgrund).`,
        evidence: { missing },
      }
    }
    return {
      key: 'voucher_cache', label: 'Verifikationscache', status: 'pending',
      detail: `${missing.length} av ${months.length} månader återstår — laddas i bakgrunden.`,
      evidence: { missing, cached_count: cached.length, total_months: months.length },
    }
  } catch (e: any) {
    return { key: 'voucher_cache', label: 'Verifikationscache', status: 'warn',
             detail: `Kunde inte bedöma cachetäckning: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 5. Opening balance sum ───────────────────────────────────────────

async function checkOpeningBalanceSum(
  db: any, orgId: string, businessId: string, accessToken: string | null,
): Promise<ReadinessCheck> {
  if (!accessToken) {
    return { key: 'opening_balance', label: 'Ingående balanser', status: 'pending',
             detail: 'Väntar på Fortnox-autentisering.' }
  }
  try {
    const r = await fetchAccountsList(db, orgId, businessId, accessToken)
    let sum = 0
    let totalAssets = 0
    for (const a of Object.values(r.accounts)) {
      const n = a.number
      if (n < 1000 || n > 2999) continue
      sum += a.opening_balance
      if (n < 2000) totalAssets += Math.abs(a.opening_balance)
    }
    // IBs across 1xxx-2xxx should balance to ~0 in any clean Fortnox.
    // Tolerance: 1 kr per million SEK of total assets, floor 5 kr.
    const tolerance = Math.max(5, totalAssets * 1e-6)
    if (Math.abs(sum) <= tolerance) {
      return {
        key: 'opening_balance', label: 'Ingående balanser', status: 'ok',
        detail: `Summa IB över 1xxx-2xxx ≈ ${formatKr(sum)}. Balanserar.`,
        evidence: { sum, total_assets: totalAssets, tolerance },
      }
    }
    // Significant imbalance — Fortnox IB is incomplete / not balanced
    return {
      key: 'opening_balance', label: 'Ingående balanser',
      status: Math.abs(sum) > totalAssets * 0.01 ? 'fail' : 'warn',
      detail: `Summa IB över 1xxx-2xxx = ${formatKr(sum)} (borde vara ≈ 0). Kontrollera bokslut i Fortnox.`,
      evidence: { sum, total_assets: totalAssets, tolerance },
    }
  } catch (e: any) {
    return { key: 'opening_balance', label: 'Ingående balanser', status: 'warn',
             detail: `Kunde inte beräkna IB-summa: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 6. Balance sheet self-check ──────────────────────────────────────

async function checkBalanceSheetSelfCheck(
  db: any, orgId: string, businessId: string,
): Promise<ReadinessCheck> {
  // Use most recent COMPLETED month for the self-check.
  const now = new Date()
  let y = now.getUTCFullYear()
  let m = now.getUTCMonth()    // already 0-indexed, so this is the prior month (1-12)
  if (m === 0) { m = 12; y -= 1 }
  try {
    const bs = await computeBalanceSheet(db, orgId, businessId, y, m)
    const imbalance = Math.abs(bs.imbalance)
    const denom = Math.max(Math.abs(bs.total_assets), Math.abs(bs.total_equity_and_liabilities), 1)
    const pct = (imbalance / denom) * 100

    // Tolerance: integer-rounding of opening balances (we round to whole
    // kr in account-balance.ts) introduces typical noise of ±1-3 kr per
    // account; a healthy customer with 50 BS accounts can accumulate up
    // to ~5 kr in legitimate rounding. Use the same scheme as the IB-sum
    // check below: floor 5 kr OR 0.001 % of total assets, whichever is
    // larger. Anything past 0.5 % is a real issue.
    const okTolerance   = Math.max(5,  Math.abs(bs.total_assets) * 1e-5)
    const warnTolerance = Math.max(50, Math.abs(bs.total_assets) * 5e-3)   // 0.5 %

    if (imbalance <= okTolerance) {
      return {
        key: 'balance_sheet', label: 'Balansräkning stämmer',
        status: 'ok',
        detail: `${y}-${String(m).padStart(2, '0')}: Tillgångar ${formatKr(bs.total_assets)} = EK+skulder ${formatKr(bs.total_equity_and_liabilities)}${imbalance >= 0.5 ? ` (±${formatKr(imbalance)} avrundning)` : ''}.`,
        evidence: { period: `${y}-${String(m).padStart(2, '0')}`, imbalance, total_assets: bs.total_assets, tolerance: okTolerance },
      }
    }
    if (imbalance <= warnTolerance) {
      return {
        key: 'balance_sheet', label: 'Balansräkning stämmer',
        status: 'warn',
        detail: `Liten obalans ${formatKr(bs.imbalance)} (${pct.toFixed(2)} %) i ${y}-${String(m).padStart(2, '0')}.`,
        evidence: { period: `${y}-${String(m).padStart(2, '0')}`, imbalance: bs.imbalance, pct },
      }
    }
    return {
      key: 'balance_sheet', label: 'Balansräkning stämmer',
      status: 'fail',
      detail: `Obalans ${formatKr(bs.imbalance)} (${pct.toFixed(1)} %) i ${y}-${String(m).padStart(2, '0')}. Vouchercache eller IB ofullständig.`,
      evidence: { period: `${y}-${String(m).padStart(2, '0')}`, imbalance: bs.imbalance, pct, total_assets: bs.total_assets },
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    // If the underlying voucher cache is still warming, this check is pending.
    if (msg.includes('Fortnox') || msg.includes('vouchers')) {
      return { key: 'balance_sheet', label: 'Balansräkning stämmer', status: 'pending',
               detail: 'Väntar på att verifikationscachen ska fyllas.' }
    }
    return { key: 'balance_sheet', label: 'Balansräkning stämmer', status: 'warn',
             detail: `Kunde inte testa: ${msg.slice(0, 120)}` }
  }
}

// ─── 7. VAT account coverage ──────────────────────────────────────────

async function checkVatCoverage(
  db: any, businessId: string, accessToken: string | null,
): Promise<ReadinessCheck> {
  if (!accessToken) {
    return { key: 'vat_coverage', label: 'Momskontotäckning', status: 'pending',
             detail: 'Väntar på Fortnox-autentisering.' }
  }
  try {
    // Look at vouchers in the last 90 days — recent enough to reflect
    // active VAT bookkeeping, old enough to include closing-month entries.
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * SECOND).toISOString().slice(0, 10)
    const { data: vouchers } = await db
      .from('fortnox_vouchers_cache')
      .select('rows')
      .eq('business_id', businessId)
      .gte('transaction_date', cutoff)
      .range(0, 9999)
    if (!vouchers || vouchers.length === 0) {
      return { key: 'vat_coverage', label: 'Momskontotäckning', status: 'pending',
               detail: 'Inga verifikationer i cachen ännu.' }
    }
    const unmappedActivity = new Map<number, { debit: number; credit: number }>()
    for (const v of vouchers) {
      for (const r of (v.rows ?? [])) {
        if ((r as any).Removed) continue
        const n = Number(r.Account)
        if (!Number.isFinite(n)) continue
        if (n < 2600 || n > 2699) continue
        const mapped = OUTPUT_VAT_ACCOUNT_TO_BOX[n] !== undefined || INPUT_VAT_ACCOUNTS.has(n)
                       || n === 2650 || n === 2648 || n === 2618 || n === 2628 || n === 2638
        if (mapped) continue
        if (!unmappedActivity.has(n)) unmappedActivity.set(n, { debit: 0, credit: 0 })
        const e = unmappedActivity.get(n)!
        e.debit  += Number(r.Debit)  || 0
        e.credit += Number(r.Credit) || 0
      }
    }
    const unmapped = [...unmappedActivity.entries()].filter(([_, e]) => Math.abs(e.debit) + Math.abs(e.credit) > 100)
    if (unmapped.length === 0) {
      return { key: 'vat_coverage', label: 'Momskontotäckning', status: 'ok',
               detail: 'Alla momskonton med aktivitet är kartlagda.' }
    }
    const sample = unmapped.slice(0, 5).map(([acc, e]) => `${acc} (${formatKr(Math.max(e.debit, e.credit))})`).join(', ')
    return {
      key: 'vat_coverage', label: 'Momskontotäckning',
      status: unmapped.length <= 2 ? 'warn' : 'fail',
      detail: `${unmapped.length} okända momskonto(n) med aktivitet: ${sample}${unmapped.length > 5 ? ' …' : ''}`,
      evidence: { unmapped_accounts: unmapped.map(([n]) => n) },
    }
  } catch (e: any) {
    return { key: 'vat_coverage', label: 'Momskontotäckning', status: 'warn',
             detail: `Kunde inte bedöma: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 8. Revenue account classification ────────────────────────────────

async function checkRevenueClassification(
  db: any, businessId: string, accessToken: string | null,
): Promise<ReadinessCheck> {
  if (!accessToken) {
    return { key: 'revenue_class', label: 'Intäktsklassificering', status: 'pending',
             detail: 'Väntar på Fortnox-autentisering.' }
  }
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * SECOND).toISOString().slice(0, 10)
    const { data: vouchers } = await db
      .from('fortnox_vouchers_cache')
      .select('rows')
      .eq('business_id', businessId)
      .gte('transaction_date', cutoff)
      .range(0, 9999)
    if (!vouchers || vouchers.length === 0) {
      return { key: 'revenue_class', label: 'Intäktsklassificering', status: 'pending',
               detail: 'Inga verifikationer i cachen ännu.' }
    }
    const otherActivity = new Map<number, number>()
    for (const v of vouchers) {
      for (const r of (v.rows ?? [])) {
        if ((r as any).Removed) continue
        const n = Number(r.Account)
        if (!Number.isFinite(n) || n < 3000 || n > 3999) continue
        const rate = classifyRevenueAccount(n)
        if (rate !== 'other') continue
        otherActivity.set(n, (otherActivity.get(n) ?? 0) + (Number(r.Credit) - Number(r.Debit) || 0))
      }
    }
    const unclassified = [...otherActivity.entries()].filter(([_, v]) => Math.abs(v) > 100)
    if (unclassified.length === 0) {
      return { key: 'revenue_class', label: 'Intäktsklassificering', status: 'ok',
               detail: 'Alla intäktskonton är kartlagda mot momssats.' }
    }
    const sample = unclassified.slice(0, 5).map(([acc, v]) => `${acc} (${formatKr(Math.abs(v))})`).join(', ')
    return {
      key: 'revenue_class', label: 'Intäktsklassificering',
      status: unclassified.length <= 2 ? 'warn' : 'warn',
      detail: `${unclassified.length} intäktskonto(n) saknar momssats: ${sample}${unclassified.length > 5 ? ' …' : ''}`,
      evidence: { unclassified: unclassified.map(([n]) => n) },
    }
  } catch (e: any) {
    return { key: 'revenue_class', label: 'Intäktsklassificering', status: 'warn',
             detail: `Kunde inte bedöma: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 9. Backfill progress (12-month PDF backfill) ─────────────────────

async function checkBackfillProgress(db: any, businessId: string): Promise<ReadinessCheck> {
  // tracker_data is the canonical P&L store. After OAuth, the Fortnox
  // 12-month backfill worker writes one row per closed month. The dash-
  // board / forecast / budget surfaces all depend on this.
  try {
    const cutoff = new Date()
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 12)
    const { count } = await db
      .from('tracker_data')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .gte('period_date', cutoff.toISOString().slice(0, 10))
    const have = count ?? 0
    if (have >= 10) {
      return { key: 'backfill', label: '12-månaders backfill',
               status: 'ok', detail: `${have} av 12 stängda månader importerade.` }
    }
    if (have >= 3) {
      return { key: 'backfill', label: '12-månaders backfill',
               status: 'pending', detail: `${have} av 12 stängda månader klara — backfill pågår.` }
    }
    return { key: 'backfill', label: '12-månaders backfill',
             status: 'pending', detail: `Backfill startad — ${have} månader klara hittills.` }
  } catch (e: any) {
    return { key: 'backfill', label: '12-månaders backfill', status: 'warn',
             detail: `Kunde inte bedöma backfill: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 10. Bookkeeping freshness ────────────────────────────────────────

async function checkBookkeepingFreshness(db: any, businessId: string): Promise<ReadinessCheck> {
  try {
    const { data } = await db
      .from('fortnox_vouchers_cache')
      .select('transaction_date')
      .eq('business_id', businessId)
      .order('transaction_date', { ascending: false })
      .limit(1)
    const latest = data?.[0]?.transaction_date
    if (!latest) {
      return { key: 'freshness', label: 'Bokföringsfärskhet',
               status: 'pending', detail: 'Väntar på första verifikationer.' }
    }
    const ageDays = Math.floor((Date.now() - new Date(latest).getTime()) / (24 * 60 * 60 * SECOND))
    if (ageDays <= 14) {
      return { key: 'freshness', label: 'Bokföringsfärskhet',
               status: 'ok', detail: `Senaste verifikation: ${latest} (${ageDays} dagar sedan).` }
    }
    if (ageDays <= 60) {
      return { key: 'freshness', label: 'Bokföringsfärskhet',
               status: 'warn', detail: `Senaste verifikation ${ageDays} dagar gammal — bokföring kan ligga efter.` }
    }
    return { key: 'freshness', label: 'Bokföringsfärskhet',
             status: 'warn', detail: `Senaste verifikation ${ageDays} dagar gammal — risk för utdaterad data.` }
  } catch (e: any) {
    return { key: 'freshness', label: 'Bokföringsfärskhet', status: 'warn',
             detail: `Kunde inte bedöma: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 11. Multi-business connection coverage ───────────────────────────

async function checkMultiBusinessConnections(
  db: any, orgId: string, businessId: string,
): Promise<ReadinessCheck> {
  // If the org has multiple businesses (multi-restaurant group), each
  // legal entity needs its own Fortnox OAuth — Fortnox is single-entity
  // per subscription. Catch the common signature of "owner connected
  // ONE restaurant, assumed it covers the others."
  try {
    const { data: siblings } = await db
      .from('businesses')
      .select('id, name, is_active')
      .eq('org_id', orgId)
      .eq('is_active', true)

    if (!siblings || siblings.length <= 1) {
      // Single-restaurant org — no multi-business risk.
      return {
        key: 'multi_business', label: 'Övriga verksamheter',
        status: 'ok',
        detail: 'Enda verksamheten i organisationen — ingen extra koppling behövs.',
      }
    }

    // Check which siblings have a connected Fortnox integration.
    const { data: ints } = await db
      .from('integrations')
      .select('business_id, status')
      .eq('org_id', orgId)
      .eq('provider', 'fortnox')
      .in('status', ['connected', 'warning'])

    const connectedIds = new Set((ints ?? []).map((i: any) => i.business_id).filter(Boolean))
    const missing = siblings.filter((s: any) => !connectedIds.has(s.id) && s.id !== businessId)

    if (missing.length === 0) {
      return {
        key: 'multi_business', label: 'Övriga verksamheter',
        status: 'ok',
        detail: `Alla ${siblings.length} verksamheter har Fortnox-koppling.`,
        evidence: { total: siblings.length, connected: siblings.length },
      }
    }
    const sample = missing.slice(0, 3).map((s: any) => s.name).join(', ')
    return {
      key: 'multi_business', label: 'Övriga verksamheter',
      status: 'warn',
      detail: `${missing.length} verksamhet(er) saknar Fortnox-koppling: ${sample}${missing.length > 3 ? ' …' : ''}`,
      evidence: { missing_business_ids: missing.map((s: any) => s.id) },
    }
  } catch (e: any) {
    return { key: 'multi_business', label: 'Övriga verksamheter', status: 'warn',
             detail: `Kunde inte bedöma: ${String(e?.message ?? e).slice(0, 120)}` }
  }
}

// ─── 12. VAT filing cadence ───────────────────────────────────────────

async function checkVatFilingCadence(biz: any): Promise<ReadinessCheck> {
  // Filing cadence isn't queryable from Fortnox — it's a Skatteverket
  // registration property. We store it on businesses.vat_filing_cadence
  // (set via /settings/setup-health or onboarding). Defaults to quarterly
  // for restaurants in the 1-40 MSEK turnover band (~95 % of our market).
  if (!biz) {
    return { key: 'vat_cadence', label: 'Momsperiod', status: 'pending',
             detail: 'Väntar på verksamhetsdata.' }
  }
  const c = biz.vat_filing_cadence as string | null
  if (c === null) {
    return {
      key: 'vat_cadence', label: 'Momsperiod', status: 'warn',
      detail: 'Inte vald ännu — sätt månadsvis / kvartalsvis / årsvis i Inställningar → Setup-status.',
      evidence: { current: null },
    }
  }
  const label = c === 'monthly' ? 'Månadsvis' : c === 'quarterly' ? 'Kvartalsvis' : 'Årsvis'
  return {
    key: 'vat_cadence', label: 'Momsperiod',
    status: 'ok',
    detail: `${label}. Driver omfånget på momsrapporten.`,
    evidence: { current: c },
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function monthsInRange(fromDate: string, toDate: string): Array<{ y: number; m: number }> {
  const out: Array<{ y: number; m: number }> = []
  const start = new Date(fromDate + 'T00:00:00Z')
  const end   = new Date(toDate   + 'T00:00:00Z')
  let y = start.getUTCFullYear()
  let m = start.getUTCMonth() + 1
  const endY = end.getUTCFullYear()
  const endM = end.getUTCMonth() + 1
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ y, m })
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

function formatKr(n: number): string {
  return `${n.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr`
}

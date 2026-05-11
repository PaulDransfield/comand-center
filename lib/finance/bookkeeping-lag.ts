// lib/finance/bookkeeping-lag.ts
//
// Phase 3 cash-visibility honesty — detect when Fortnox's booked bank
// balance probably lags the customer's actual live bank balance because
// the accountant hasn't entered recent bank movements.
//
// Signal: a healthy operating month on the primary checking account (1930)
// shows BOTH debit and credit activity — deposits coming in AND payments
// going out. If recent months show credits-only (outflows only, no booked
// inflows) on a business that demonstrably has revenue (POS data exists),
// that's the bookkeeping-lag signature. Vero April + May 2026 are the
// canonical example.
//
// Output is consumed by the Cash Position tile to surface a warning chip:
// "Books behind: deposits not booked since 2026-03-31."
//
// Pure-compute over rows already in tracker_data — no new fetches.

export interface BookkeepingLagSignal {
  /** True when at least the most recent month on the primary checking
   *  account shows credits-only activity (cash going out, nothing coming
   *  in) AND the business demonstrably had revenue in that period (POS
   *  data exists). False otherwise. */
  detected:              boolean
  /** Severity ranking — 'high' when 2+ recent months are credits-only.
   *  Drives whether the UI uses a warning colour or just an info hint. */
  severity:              'none' | 'low' | 'high'
  /** Latest month where the primary checking saw a deposit (debit on 1930).
   *  Owner-actionable: "deposits not booked since X". */
  last_inflow_period:    string | null   // 'YYYY-MM'
  /** Number of consecutive recent months with credits-only activity. */
  outflow_only_months:   number
  /** Plain-English line ready to show on the tile. Empty when detected=false. */
  message:               string
}

export interface BookkeepingLagInput {
  /** Most-recent-first list of monthly bank_accounts breakdowns from
   *  tracker_data. Only rows where bank data exists. */
  rows: Array<{
    period_year:    number
    period_month:   number
    bank_accounts:  Record<string, { debit: number; credit: number; net: number }> | null
    /** Did the business have non-zero POS revenue this month? Used to
     *  distinguish "credits-only because the place was closed" (legitimate)
     *  vs "credits-only because deposits weren't booked" (lag). */
    had_revenue:    boolean
  }>
  /** Account number to inspect. Default 1930 (Företagskonto / primary
   *  checking) — that's where deposit lag shows up first in Swedish
   *  bookkeeping. Cash registers (1910-1919) tend to be reconciled
   *  separately and have a different rhythm. */
  primaryAccount?: number
}

const DEFAULT_PRIMARY_ACCOUNT = 1930

export function detectBookkeepingLag(input: BookkeepingLagInput): BookkeepingLagSignal {
  const primary = input.primaryAccount ?? DEFAULT_PRIMARY_ACCOUNT
  // Rows are expected newest-first; defensively re-sort.
  const rows = [...input.rows].sort((a, b) => {
    if (a.period_year !== b.period_year) return b.period_year - a.period_year
    return b.period_month - a.period_month
  })

  if (rows.length === 0) {
    return { detected: false, severity: 'none', last_inflow_period: null, outflow_only_months: 0, message: '' }
  }

  // Walk newest→older. Count consecutive outflow-only months at the head.
  // Stop as soon as we hit a month with BOTH credit and debit activity on
  // the primary account, or a month with no activity at all (no business
  // running → not a lag signal, could be vacation or genuine zero).
  let outflowOnly  = 0
  let lastInflow: string | null = null

  for (const r of rows) {
    const acc = r.bank_accounts?.[String(primary)]
    if (!acc) continue   // primary account had no activity that month — skip
    const debit  = Number(acc.debit  ?? 0)
    const credit = Number(acc.credit ?? 0)

    if (debit > 0) {
      // Inflow found — last_inflow_period set, then break (no more lag).
      lastInflow = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`
      break
    }
    if (credit > 0 && debit === 0) {
      // Outflow-only month. Only counts as lag-evidence if business had
      // revenue this month (i.e. they were operating). A closed business
      // legitimately has credit-only months (paying off rent on an
      // empty space).
      if (r.had_revenue) outflowOnly++
      else break   // closed month — stop counting, not a lag signal
    } else {
      // No activity at all — neutral, walk past.
      continue
    }
  }

  if (outflowOnly === 0) {
    return { detected: false, severity: 'none', last_inflow_period: lastInflow, outflow_only_months: 0, message: '' }
  }

  const severity = outflowOnly >= 2 ? 'high' : 'low'
  const message = lastInflow
    ? `Books behind: no bank deposits booked since ${lastInflow}.`
    : `Books behind: no bank deposits booked recently on account ${primary}.`

  return {
    detected:           true,
    severity,
    last_inflow_period: lastInflow,
    outflow_only_months: outflowOnly,
    message,
  }
}

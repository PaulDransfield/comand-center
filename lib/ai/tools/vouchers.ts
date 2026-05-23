// lib/ai/tools/vouchers.ts
//
// AI tools that wrap the voucher cache + supplier invoice feed:
//   - search_vouchers          → fortnox_vouchers_cache filtered by date/account/supplier
//   - search_supplier_invoices → __recent_invoices_* cache + Fortnox supplier feed
//
// These let the LLM answer questions that need detail beyond the
// tracker_data monthly aggregates:
//   - "Which supplier raised prices last month?"
//   - "Show me my biggest 5 supplier invoices in March"
//   - "What was booked on account 6212 (mobiltelefoni) this quarter?"
//   - "Are there any unpaid invoices over 10,000 kr?"

import type { AnthropicToolDef, ToolContext } from './index'

export const VOUCHER_TOOLS: AnthropicToolDef[] = [
  {
    name: 'search_vouchers',
    description:
      `Search the cached Fortnox voucher journal. Returns matching vouchers ` +
      `(maximum 25 rows) with date / series / number / description / ` +
      `aggregated debit + credit. Optional filters: date range, single account ` +
      `number, supplier-name substring.\n\n` +
      `Use to investigate a specific account's activity, find vouchers tied ` +
      `to a supplier, or confirm whether a particular cost was booked. Useful ` +
      `for "why did account 4011 spike in March?" — call with account=4011 + ` +
      `date_from='2026-03-01' + date_to='2026-03-31' and inspect the rows.`,
    input_schema: {
      type: 'object',
      properties: {
        date_from:        { type: 'string', description: 'YYYY-MM-DD inclusive' },
        date_to:          { type: 'string', description: 'YYYY-MM-DD inclusive' },
        account:          { type: 'integer', description: 'Filter to vouchers that touch this BAS account' },
        supplier_substring: { type: 'string', description: 'Filter to vouchers whose description contains this substring (case-insensitive)' },
        limit:            { type: 'integer', description: 'Max rows to return (default 25, max 50)' },
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'search_supplier_invoices',
    description:
      `Search recent Fortnox supplier invoices (the live /supplierinvoices ` +
      `feed). Returns up to 25 invoices with supplier name, invoice date, ` +
      `total, currency, payment status (paid/overdue/pending), and a link to ` +
      `the Fortnox web app.\n\n` +
      `Use for "what's my largest unpaid invoice", "show me supplier invoices ` +
      `from Martin Servera this month", "any overdue?". For supplier-specific ` +
      `questions pass supplier_substring; otherwise just date range works.\n\n` +
      `Data source: a 5-min Postgres cache populated by /api/integrations/` +
      `fortnox/recent-invoices, which calls Fortnox /supplierinvoices. If the ` +
      `cache is stale and Fortnox is unreachable, you may get up to 90-day-old ` +
      `data — the result includes a freshness timestamp.`,
    input_schema: {
      type: 'object',
      properties: {
        date_from:          { type: 'string', description: 'YYYY-MM-DD inclusive (default: 90 days ago)' },
        date_to:            { type: 'string', description: 'YYYY-MM-DD inclusive (default: today)' },
        supplier_substring: { type: 'string', description: 'Case-insensitive substring filter on supplier name' },
        status_filter:      { type: 'string', enum: ['paid', 'overdue', 'pending', 'any'], description: 'Filter to payment status (default any)' },
        limit:              { type: 'integer', description: 'Max rows (default 25, max 50)' },
      },
      required: [],
    },
  },
]

export async function runVoucherTool(
  ctx:  ToolContext,
  name: 'search_vouchers' | 'search_supplier_invoices',
  args: any,
): Promise<any> {
  if (name === 'search_vouchers') {
    const dateFrom = String(args.date_from ?? '').slice(0, 10)
    const dateTo   = String(args.date_to   ?? '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return { error: 'invalid_args', detail: 'date_from + date_to (YYYY-MM-DD) required' }
    }
    const limit = Math.min(50, Math.max(1, parseInt(String(args.limit ?? 25), 10) || 25))
    const accountFilter   = args.account != null ? parseInt(String(args.account), 10) : null
    const supplierFilter  = (args.supplier_substring ?? '').toString().toLowerCase().trim()

    // Pull candidate vouchers (paginated past 1000-row cap)
    const all: any[] = []
    let from = 0
    while (true) {
      const { data } = await ctx.db
        .from('fortnox_vouchers_cache')
        .select('voucher_series, voucher_number, transaction_date, description, rows, debit_total, credit_total')
        .eq('business_id', ctx.businessId)
        .gte('transaction_date', dateFrom)
        .lte('transaction_date', dateTo)
        .order('transaction_date', { ascending: false })
        .range(from, from + 999)
      if (!data || data.length === 0) break
      all.push(...data)
      if (data.length < 1000) break
      from += 1000
      if (all.length >= 5000) break  // safety
    }

    // Apply filters in-memory (account requires inspecting rows; supplier filters description)
    const filtered = all.filter(v => {
      if (supplierFilter && !(v.description ?? '').toLowerCase().includes(supplierFilter)) return false
      if (accountFilter != null) {
        const hits = (v.rows ?? []).some((r: any) => Number(r.Account) === accountFilter)
        if (!hits) return false
      }
      return true
    })

    // Project to LLM-readable shape
    const out = filtered.slice(0, limit).map(v => {
      const rowsForAccount = accountFilter != null
        ? (v.rows ?? []).filter((r: any) => Number(r.Account) === accountFilter)
        : (v.rows ?? []).slice(0, 5)   // first 5 rows for context
      return {
        date:        v.transaction_date,
        series:      v.voucher_series,
        number:      v.voucher_number,
        description: v.description,
        debit_total: v.debit_total,
        credit_total: v.credit_total,
        rows: rowsForAccount.map((r: any) => ({
          account:     Number(r.Account),
          description: r.AccountDescription ?? null,
          debit:       Number(r.Debit  ?? 0) || 0,
          credit:      Number(r.Credit ?? 0) || 0,
        })),
      }
    })

    return {
      date_range:    `${dateFrom} → ${dateTo}`,
      total_matched: filtered.length,
      returned:      out.length,
      truncated:     filtered.length > out.length,
      vouchers:      out,
      filters_applied: {
        account:           accountFilter,
        supplier_substring: supplierFilter || null,
      },
    }
  }

  if (name === 'search_supplier_invoices') {
    const today = new Date().toISOString().slice(0, 10)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    const dateFrom = String(args.date_from ?? ninetyDaysAgo).slice(0, 10)
    const dateTo   = String(args.date_to   ?? today).slice(0, 10)
    const supplierFilter = (args.supplier_substring ?? '').toString().toLowerCase().trim()
    const statusFilter   = String(args.status_filter ?? 'any')
    const limit = Math.min(50, Math.max(1, parseInt(String(args.limit ?? 25), 10) || 25))

    // Look for any cached __recent_invoices_*__ payload (freshest first)
    const { data: rows } = await ctx.db
      .from('overhead_drilldown_cache')
      .select('payload, fetched_at, category')
      .eq('business_id', ctx.businessId)
      .eq('period_year',  0)
      .eq('period_month', 0)
      .like('category',   '__recent_invoices_%')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!rows?.payload) {
      return {
        error: 'no_cached_invoices',
        detail: 'No supplier invoice cache for this business. Customer may not have visited /invoices yet, or Fortnox call hasn\'t happened.',
        suggestion: 'Tell the user to visit /invoices to trigger a fresh fetch from Fortnox.',
      }
    }

    const inv = ((rows.payload as any).invoices ?? []) as any[]
    const filtered = inv.filter(i => {
      if (i.invoice_date < dateFrom || i.invoice_date > dateTo) return false
      if (supplierFilter && !(i.supplier_name ?? '').toLowerCase().includes(supplierFilter)) return false
      if (statusFilter !== 'any' && i.status !== statusFilter) return false
      return true
    })

    const out = filtered.slice(0, limit).map(i => ({
      supplier:        i.supplier_name,
      invoice_number:  i.invoice_number,
      invoice_date:    i.invoice_date,
      due_date:        i.due_date,
      total:           i.total,
      currency:        i.currency,
      status:          i.status,
      balance_remaining: i.balance,
      fortnox_url:     i.fortnox_url,
    }))

    const totalAmount = filtered.reduce((s, i) => s + (Number(i.total) || 0), 0)
    return {
      date_range:    `${dateFrom} → ${dateTo}`,
      total_matched: filtered.length,
      returned:      out.length,
      truncated:     filtered.length > out.length,
      sum_total:     Math.round(totalAmount),
      filters_applied: {
        supplier_substring: supplierFilter || null,
        status_filter:      statusFilter,
      },
      cache_freshness: rows.fetched_at,
      invoices:      out,
    }
  }

  return { error: 'unknown_tool', name }
}

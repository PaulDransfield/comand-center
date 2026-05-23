// lib/ai/tools/revisor.ts
//
// AI tools that wrap the revisor compute layer:
//   - get_balance_sheet  → lib/revisor/balance-sheet.ts::computeBalanceSheet
//   - get_momsrapport    → lib/revisor/momsrapport.ts::computeMomsrapport
//   - get_account_balance → per-account v2 cache (Postgres-only read)
//
// These let the LLM answer specific-period questions ("show me February
// balance sheet", "what was the box 49 VAT for Q1?") without needing to
// re-implement the math in the prompt.

import type { AnthropicToolDef, ToolContext } from './index'

export const REVISOR_TOOLS: AnthropicToolDef[] = [
  {
    name: 'get_balance_sheet',
    description:
      `Compute the full Swedish balansräkning (balance sheet) for a specific (year, month).\n` +
      `Returns assets / equity / liabilities sections with per-account lines, totals, ` +
      `imbalance check, and YTD result. Cached after first call per month.\n\n` +
      `Use when the user asks about balance sheet items, fixed assets, equity, ` +
      `'did my books balance', or wants to compare two periods. Pick the most recent ` +
      `CLOSED month if the user doesn't specify (this month is usually still open).`,
    input_schema: {
      type: 'object',
      properties: {
        year:  { type: 'integer', description: '4-digit year, e.g. 2026' },
        month: { type: 'integer', description: '1-12' },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'get_momsrapport',
    description:
      `Compute the Skatteverket SKV 4700 momsrapport (Swedish VAT report) for a ` +
      `specific (year, month). Returns boxes 05-08 (taxable sales excl. VAT), ` +
      `10-12 (output VAT 25/12/6%), 30-32 (reverse-charge VAT), 48 (input VAT), ` +
      `35-40 (foreign sales), and 49 (net VAT to pay/recover), plus a ` +
      `reconciliation check comparing declared 3xxx sales against implied sales ` +
      `from the VAT collected.\n\n` +
      `Use when the user asks about VAT, moms, Skatteverket-filing, or ` +
      `'how much do I owe in VAT'. For quarterly filers, you can call this for each ` +
      `month in the quarter and sum, but the per-month boxes are the canonical view.`,
    input_schema: {
      type: 'object',
      properties: {
        year:  { type: 'integer', description: '4-digit year' },
        month: { type: 'integer', description: '1-12' },
      },
      required: ['year', 'month'],
    },
  },
  {
    name: 'get_account_balance',
    description:
      `Look up the current closing balance for a single Fortnox account (any number, ` +
      `not just bank accounts). Reads from the per-account v2 cache so it's an ` +
      `instant Postgres read. Returns { account, description, opening_balance, ` +
      `current_balance, fiscal_year_from, fiscal_year_to, fetched_at }.\n\n` +
      `Use to confirm a specific account's balance: 'what's the balance on 2440?' ` +
      `(leverantörsskulder), 'how much in 1930?' (bank), '1220 + 1229 net?' (fixed ` +
      `assets less depreciation).`,
    input_schema: {
      type: 'object',
      properties: {
        account: { type: 'integer', description: 'BAS account number, e.g. 1930 (bank), 2440 (leverantörsskulder), 3001 (revenue)' },
      },
      required: ['account'],
    },
  },
]

export async function runRevisorTool(
  ctx:  ToolContext,
  name: 'get_balance_sheet' | 'get_momsrapport' | 'get_account_balance',
  args: any,
): Promise<any> {
  if (name === 'get_balance_sheet') {
    const year  = parseInt(String(args.year), 10)
    const month = parseInt(String(args.month), 10)
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return { error: 'invalid_args', detail: 'year + month required (year=YYYY, month=1-12)' }
    }
    const { computeBalanceSheet } = await import('@/lib/revisor/balance-sheet')
    const bs = await computeBalanceSheet(ctx.db, ctx.orgId, ctx.businessId, year, month)
    // Trim per-line description verbosity to keep token cost down. The LLM
    // gets totals + per-group rollups + headline imbalance — enough to
    // answer almost any balance-sheet question.
    return {
      period_end_date: bs.period_end_date,
      fiscal_year:     `${bs.fiscal_year_from} → ${bs.fiscal_year_to}`,
      total_assets:                 bs.total_assets,
      total_equity_and_liabilities: bs.total_equity_and_liabilities,
      imbalance:                    bs.imbalance,
      ytd_result:                   bs.ytd_result,
      voucher_count:                bs.voucher_count,
      assets: {
        total: bs.assets.total,
        groups: bs.assets.groups.map(g => ({
          title: g.title,
          total: g.total,
          lines: g.lines.slice(0, 12).map(l => ({ account: l.account, description: l.description, amount: l.amount })),
          truncated: g.lines.length > 12 ? `+${g.lines.length - 12} more` : null,
        })),
      },
      equity: {
        total: bs.equity.total,
        groups: bs.equity.groups.map(g => ({
          title: g.title,
          total: g.total,
          lines: g.lines.slice(0, 12).map(l => ({ account: l.account, description: l.description, amount: l.amount })),
          truncated: g.lines.length > 12 ? `+${g.lines.length - 12} more` : null,
        })),
      },
      liabilities: {
        total: bs.liabilities.total,
        groups: bs.liabilities.groups.map(g => ({
          title: g.title,
          total: g.total,
          lines: g.lines.slice(0, 12).map(l => ({ account: l.account, description: l.description, amount: l.amount })),
          truncated: g.lines.length > 12 ? `+${g.lines.length - 12} more` : null,
        })),
      },
    }
  }

  if (name === 'get_momsrapport') {
    const year  = parseInt(String(args.year), 10)
    const month = parseInt(String(args.month), 10)
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return { error: 'invalid_args', detail: 'year + month required' }
    }
    const { computeMomsrapport } = await import('@/lib/revisor/momsrapport')
    const m = await computeMomsrapport(ctx.db, ctx.orgId, ctx.businessId, year, month)
    return {
      period_label: m.period_label,
      period_from:  m.period_from,
      period_to:    m.period_to,
      // Section A — Sales
      box_05: { label: m.box_05.label, amount: m.box_05.amount },
      box_06: { label: m.box_06.label, amount: m.box_06.amount },
      box_07: { label: m.box_07.label, amount: m.box_07.amount },
      box_08: { label: m.box_08.label, amount: m.box_08.amount },
      // Section B — Output VAT
      box_10: { label: m.box_10.label, amount: m.box_10.amount, contributing_accounts: m.box_10.lines.map(l => l.account) },
      box_11: { label: m.box_11.label, amount: m.box_11.amount, contributing_accounts: m.box_11.lines.map(l => l.account) },
      box_12: { label: m.box_12.label, amount: m.box_12.amount, contributing_accounts: m.box_12.lines.map(l => l.account) },
      // Section D — Reverse-charge
      box_30: { label: m.box_30.label, amount: m.box_30.amount },
      box_31: { label: m.box_31.label, amount: m.box_31.amount },
      box_32: { label: m.box_32.label, amount: m.box_32.amount },
      // Section E — Input VAT
      box_48: { label: m.box_48.label, amount: m.box_48.amount, contributing_accounts: m.box_48.lines.map(l => l.account) },
      // Section F — Foreign sales
      box_35: { label: m.box_35.label, amount: m.box_35.amount },
      box_36: { label: m.box_36.label, amount: m.box_36.amount },
      box_38: { label: m.box_38.label, amount: m.box_38.amount },
      box_39: { label: m.box_39.label, amount: m.box_39.amount },
      box_40: { label: m.box_40.label, amount: m.box_40.amount },
      // G — Net
      total_output_vat: m.total_output_vat,
      total_input_vat:  m.total_input_vat,
      box_49_net:       m.box_49,
      box_49_direction: m.box_49 >= 0 ? 'to_pay_skatteverket' : 'to_recover_from_skatteverket',
      // Reconciliation
      reconciliation: m.reconciliation,
      voucher_count:  m.voucher_count,
    }
  }

  if (name === 'get_account_balance') {
    const account = parseInt(String(args.account), 10)
    if (!Number.isFinite(account)) return { error: 'invalid_args', detail: 'account (integer) required' }

    // Try the per-account v2 cache first (newest fy)
    const { data: rows } = await ctx.db
      .from('overhead_drilldown_cache')
      .select('payload, fetched_at, category')
      .eq('business_id', ctx.businessId)
      .eq('period_month', 0)
      .like('category', `__bank_balance_v2_${account}_fy%`)
      .order('fetched_at', { ascending: false })
      .limit(1)
    const v2 = rows?.[0]?.payload
    if (v2) {
      return {
        account:           v2.account,
        description:       v2.description,
        opening_balance:   v2.opening_balance,
        current_balance:   v2.current_balance,
        fiscal_year_from:  v2.fiscal_year_from,
        fiscal_year_to:    v2.fiscal_year_to,
        source:            'per_account_v2_cache',
        fetched_at:        v2.fetched_at,
      }
    }

    // Fallback: try the accounts list cache (opening only — current is unreliable from bulk endpoint)
    const { data: alRow } = await ctx.db
      .from('overhead_drilldown_cache')
      .select('payload')
      .eq('business_id', ctx.businessId)
      .eq('period_month', 0)
      .like('category', '__accounts_list_fy%')
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const al = alRow?.payload
    if (al?.accounts?.[account]) {
      const a = al.accounts[account]
      return {
        account:           a.number,
        description:       a.description,
        opening_balance:   a.opening_balance,
        current_balance:   null,
        current_note:      'Not in per-account cache; bulk accounts-list endpoint returns 0 for current_balance — only opening is reliable here. Tell the user to view it on /revisor/[biz]/[year]/[month] for the live figure.',
        fiscal_year_from:  al.fiscal_year_from,
        fiscal_year_to:    al.fiscal_year_to,
        source:            'accounts_list_cache',
      }
    }

    return { error: 'account_not_cached', detail: `No cached balance for account ${account}. The account may not exist on this customer's Fortnox chart, or hasn't been fetched yet.` }
  }

  return { error: 'unknown_tool', name }
}

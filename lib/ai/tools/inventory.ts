// lib/ai/tools/inventory.ts
//
// AI tools for the inventory catalogue (Phase 5).
//
// Two tools:
//   - search_inventory_products(query)         → products + product_aliases lookup
//   - get_invoice_lines(invoice_number)        → supplier_invoice_lines for one invoice
//   - get_inventory_summary()                  → catalogue size + PDF-extraction state
//
// The catalogue may be empty (Phase A backfill ran but Phase B PDF
// extraction hasn't completed). When empty, the tools return an
// explicit status that the LLM can relay to the customer:
// "your inventory catalogue isn't populated yet — pending PDF
// extraction of 762 invoices."

import type { AnthropicToolDef, ToolContext } from './index'

export const INVENTORY_TOOLS: AnthropicToolDef[] = [
  {
    name: 'search_inventory_products',
    description:
      `Search the customer's inventory catalogue. Matches on product name OR alias ` +
      `(case-insensitive, fuzzy). Returns up to 20 products with their canonical name, ` +
      `category, default supplier, last-seen price, and total aliases.\n\n` +
      `Use for "what did I buy from Martin Servera last time?", "what brands of vodka ` +
      `do I stock?", "find product X". If the catalogue is empty, the tool returns a ` +
      `clear status saying so — relay this to the user rather than inventing items.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search — product name or alias substring' },
        limit: { type: 'integer', description: 'Max products to return (default 20, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_invoice_lines',
    description:
      `Return the itemised line items for one supplier invoice (by Fortnox invoice ` +
      `number). Includes supplier, date, per-line description, quantity, unit, price, ` +
      `total, VAT rate, matched product_id if known.\n\n` +
      `Use for "what was on Martin Servera invoice 12345", "show me the lines from ` +
      `April 14th's Carlsberg invoice". Returns empty if the invoice exists at the ` +
      `header level (in /supplierinvoices feed) but hasn't been line-itemised yet — ` +
      `tell the user PDF extraction is still pending for that invoice.`,
    input_schema: {
      type: 'object',
      properties: {
        fortnox_invoice_number: { type: 'string', description: 'Fortnox invoice number (string)' },
      },
      required: ['fortnox_invoice_number'],
    },
  },
  {
    name: 'get_inventory_summary',
    description:
      `Report the overall state of the inventory catalogue for this business: ` +
      `total products, total aliases, total supplier invoice lines, and PDF ` +
      `extraction progress (extracted / pending / needs_review / no_pdf).\n\n` +
      `Use when asked about overall catalogue health, or as a pre-flight before ` +
      `recommending an action ("can I do supplier price comparison?" → call this ` +
      `to see if the data exists).`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'generate_report',
    description:
      `Build a downloadable PDF / Word / PowerPoint report for the current business. ` +
      `Returns a URL the user can click to download. Use AFTER you've already shown ` +
      `the answer in chat — the report is for the user to save / share / print.\n\n` +
      `Available report types: 'margin', 'cost', 'supplier', 'top-products'. The ` +
      `'top-products' type accepts optional supplier_filter, date_from, date_to, ` +
      `rank_by ('spend'|'quantity'|'invoice_count'), and limit params — exactly the ` +
      `same filters as top_products_by_supplier. When the user says "make it a PDF" / ` +
      `"download as Word" / "send me a deck", call this with the matching format.`,
    input_schema: {
      type: 'object',
      properties: {
        report_type:     { type: 'string', enum: ['margin','cost','supplier','top-products'], description: 'Which report to build.' },
        format:          { type: 'string', enum: ['pdf','docx','pptx'], description: 'Output format (default pdf).' },
        supplier_filter: { type: 'string', description: 'top-products only — substring on supplier name.' },
        date_from:       { type: 'string', description: 'top-products only — YYYY-MM-DD.' },
        date_to:         { type: 'string', description: 'top-products only — YYYY-MM-DD.' },
        rank_by:         { type: 'string', enum: ['spend','quantity','invoice_count'], description: 'top-products only — ranking metric.' },
        limit:           { type: 'integer', description: 'top-products only — top N.' },
      },
      required: ['report_type'],
    },
  },
  {
    name: 'top_products_by_supplier',
    description:
      `Rank products by total quantity OR total spend across every supplier invoice ` +
      `line at this business. Filter by supplier name, product name, and/or date ` +
      `range. Returns the top N products with their aggregated stats.\n\n` +
      `Use for "top 20 most-bought items from Martin Servera", "biggest spend ` +
      `with Spendrups this year", "how much butter did I buy last month" (set ` +
      `product_filter="smör" + date_from/date_to), "all my olive oil purchases ` +
      `in May" (product_filter="olivolja"). Without filters the ranking spans ` +
      `every supplier / product / line in history. Search is in Swedish since ` +
      `that's the language of the supplier invoices.`,
    input_schema: {
      type: 'object',
      properties: {
        supplier_filter: { type: 'string', description: 'Substring match on supplier name (e.g. "martin servera"). Omit for all suppliers.' },
        product_filter:  { type: 'string', description: 'Substring match on product name OR raw invoice description (e.g. "smör" for butter, "olivolja" for olive oil, "tomat"). Searches both the catalogue name and the original invoice text. Omit for all products.' },
        date_from:       { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive). Omit for no lower bound.' },
        date_to:         { type: 'string', description: 'ISO date YYYY-MM-DD (inclusive). Omit for no upper bound.' },
        rank_by:         { type: 'string', enum: ['spend', 'quantity', 'invoice_count'], description: 'spend = sum(total_excl_vat) [default], quantity = sum(quantity), invoice_count = distinct invoice count' },
        limit:           { type: 'integer', description: 'Top N to return (default 20, max 100)' },
      },
    },
  },
  {
    name: 'analyse_avtal_candidates',
    description:
      `Rank products by how attractive they would be on a supplier contract ` +
      `("avtal" — Swedish for negotiated-price agreement). Combines spend, ` +
      `purchase frequency, price volatility, and price trend into a single ` +
      `avtal_score. Each row carries reason flags explaining WHY it scored high.\n\n` +
      `Use for "which items should I put on my avtal list", "what should I ` +
      `negotiate a contract for", "where can I save the most money on procurement". ` +
      `Default looks at last 12 months across every supplier; pass supplier_filter ` +
      `to scope to one. Products bought fewer than min_invoices times are excluded ` +
      `(default 3) — one-off purchases aren't real contract candidates.`,
    input_schema: {
      type: 'object',
      properties: {
        supplier_filter: { type: 'string', description: 'Substring match on supplier name. Omit for all suppliers.' },
        months_back:     { type: 'integer', description: 'Trailing months to analyse (default 12, max 24).' },
        min_invoices:    { type: 'integer', description: 'Minimum distinct invoices required to qualify (default 3).' },
        top_n:           { type: 'integer', description: 'Top N candidates to return (default 20, max 50).' },
      },
    },
  },
  {
    name: 'get_product_price_history',
    description:
      `Return the full price history for one product — every supplier-invoice ` +
      `line that contained this product, sorted newest first. Includes price ` +
      `per unit, quantity, supplier, date, and source invoice number.\n\n` +
      `Use for "has the price of X gone up?", "compare prices across suppliers ` +
      `for X", "when did we first buy X?". Identify the product by ID (call ` +
      `search_inventory_products first if you only have a name).`,
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'Product UUID from search_inventory_products' },
        limit:      { type: 'integer', description: 'Max history rows to return (default 30, max 100)' },
      },
      required: ['product_id'],
    },
  },
]

export async function runInventoryTool(
  ctx:  ToolContext,
  name: 'search_inventory_products' | 'get_invoice_lines' | 'get_inventory_summary' | 'get_product_price_history' | 'top_products_by_supplier' | 'analyse_avtal_candidates' | 'generate_report',
  args: any,
): Promise<any> {
  if (name === 'generate_report') {
    const reportType = String(args.report_type ?? '').trim()
    if (!['margin','cost','supplier','top-products'].includes(reportType)) {
      return { error: 'invalid_args', detail: 'report_type must be margin | cost | supplier | top-products' }
    }
    const format = ['pdf','docx','pptx'].includes(args.format) ? args.format : 'pdf'
    const qs = new URLSearchParams({ business_id: ctx.businessId, format })
    if (reportType === 'top-products') {
      if (args.supplier_filter) qs.set('supplier_filter', String(args.supplier_filter))
      if (args.date_from)       qs.set('date_from',       String(args.date_from))
      if (args.date_to)         qs.set('date_to',         String(args.date_to))
      if (args.rank_by)         qs.set('rank_by',         String(args.rank_by))
      if (args.limit)           qs.set('limit',           String(args.limit))
    }
    const path = `/api/reports/${reportType}?${qs.toString()}`
    return {
      report_type: reportType,
      format,
      download_url: path,
      message: `Report ready. Click to download: ${path}`,
      ui_hint: 'Render the URL as a clickable link. The user needs to click to start the download — the file is streamed on demand, not pre-generated.',
    }
  }

  if (name === 'top_products_by_supplier') {
    const supplierFilter = args.supplier_filter ? String(args.supplier_filter).trim().toLowerCase() : null
    const productFilter  = args.product_filter  ? String(args.product_filter).trim().toLowerCase()  : null
    const dateFrom       = args.date_from ? String(args.date_from).trim() : null
    const dateTo         = args.date_to   ? String(args.date_to).trim()   : null
    const rankBy         = (['spend','quantity','invoice_count'] as const).includes(args.rank_by) ? args.rank_by : 'spend'
    const limit          = Math.min(100, Math.max(1, parseInt(String(args.limit ?? 20), 10) || 20))

    // Pull all matching lines. Bound by date if given. Aggregation is
    // client-side because PostgREST doesn't expose SQL GROUP BY directly
    // without a view/RPC, and supplier_invoice_lines is bounded per
    // business (Chicce: 9k, Vero: 8k — well within memory).
    let q = ctx.db
      .from('supplier_invoice_lines')
      .select('product_alias_id, raw_description, supplier_name_snapshot, supplier_fortnox_number, quantity, unit, total_excl_vat, price_per_unit, invoice_date, fortnox_invoice_number')
      .eq('business_id', ctx.businessId)
      .not('product_alias_id', 'is', null)   // only matched lines roll up cleanly
    if (supplierFilter) q = q.ilike('supplier_name_snapshot', `%${supplierFilter}%`)
    if (dateFrom)       q = q.gte('invoice_date', dateFrom)
    if (dateTo)         q = q.lte('invoice_date', dateTo)
    const { data: lines, error } = await q.range(0, 49_999)
    if (error) return { error: 'query_failed', detail: error.message }
    if (!lines || lines.length === 0) {
      return { matches: [], message: 'No matched supplier_invoice_lines for the given filters.', filters: { supplierFilter, dateFrom, dateTo, rankBy, limit } }
    }

    // Map alias_id → product_id → product_name. Batch the alias lookup.
    const aliasIds = Array.from(new Set(lines.map((l: any) => l.product_alias_id).filter(Boolean)))
    const aliasToProduct = new Map<string, string>()
    for (let i = 0; i < aliasIds.length; i += 100) {
      const slice = aliasIds.slice(i, i + 100)
      const { data: aRows } = await ctx.db.from('product_aliases').select('id, product_id').in('id', slice)
      for (const a of aRows ?? []) aliasToProduct.set((a as any).id, (a as any).product_id)
    }
    const productIds = Array.from(new Set(Array.from(aliasToProduct.values())))
    const productById = new Map<string, any>()
    for (let i = 0; i < productIds.length; i += 100) {
      const slice = productIds.slice(i, i + 100)
      const { data: pRows } = await ctx.db.from('products').select('id, name, category, default_supplier_name').in('id', slice)
      for (const p of pRows ?? []) productById.set((p as any).id, p)
    }

    // Aggregate. When product_filter is set we accept lines where EITHER the
    // catalogue name OR the raw invoice description contains the query
    // substring. Owner asks in their own language ("smör", "olivolja"); the
    // raw description usually carries that token and the catalogue name
    // catches anything that's been renamed.
    type Agg = { product_id: string; name: string; category: string | null; supplier: string | null; total_spend: number; total_quantity: number; line_count: number; invoice_numbers: Set<string>; last_date: string | null; matched: boolean }
    const agg = new Map<string, Agg>()
    for (const l of lines as any[]) {
      const pid = aliasToProduct.get(l.product_alias_id)
      if (!pid) continue
      const prod = productById.get(pid)
      if (!prod) continue
      const lineMatchesFilter = !productFilter
        || (prod.name && String(prod.name).toLowerCase().includes(productFilter))
        || (l.raw_description && String(l.raw_description).toLowerCase().includes(productFilter))
      let row = agg.get(pid)
      if (!row) {
        row = { product_id: pid, name: prod.name, category: prod.category, supplier: prod.default_supplier_name ?? l.supplier_name_snapshot ?? null,
                total_spend: 0, total_quantity: 0, line_count: 0, invoice_numbers: new Set(), last_date: null, matched: false }
        agg.set(pid, row)
      }
      if (lineMatchesFilter) row.matched = true
      const spend = l.total_excl_vat != null ? Number(l.total_excl_vat)
                  : (l.price_per_unit != null && l.quantity != null) ? Number(l.price_per_unit) * Number(l.quantity)
                  : 0
      row.total_spend    += Number.isFinite(spend) ? spend : 0
      row.total_quantity += l.quantity != null ? Number(l.quantity) : 0
      row.line_count     += 1
      if (l.fortnox_invoice_number) row.invoice_numbers.add(String(l.fortnox_invoice_number))
      if (l.invoice_date && (!row.last_date || l.invoice_date > row.last_date)) row.last_date = l.invoice_date
    }

    const filtered = productFilter ? Array.from(agg.values()).filter(r => r.matched) : Array.from(agg.values())
    const ranked = filtered.sort((a, b) => {
      if (rankBy === 'quantity')      return b.total_quantity - a.total_quantity
      if (rankBy === 'invoice_count') return b.invoice_numbers.size - a.invoice_numbers.size
      return b.total_spend - a.total_spend
    }).slice(0, limit)

    return {
      filters: { supplierFilter, productFilter, dateFrom, dateTo, rankBy, limit },
      total_lines_aggregated: lines.length,
      total_products_aggregated: agg.size,
      total_products_matched: filtered.length,
      top: ranked.map((r, i) => ({
        rank:           i + 1,
        product_id:     r.product_id,
        name:           r.name,
        category:       r.category,
        supplier:       r.supplier,
        total_spend:    Math.round(r.total_spend * 100) / 100,
        total_quantity: Math.round(r.total_quantity * 1000) / 1000,
        invoice_count:  r.invoice_numbers.size,
        line_count:     r.line_count,
        last_seen:      r.last_date,
      })),
    }
  }

  if (name === 'analyse_avtal_candidates') {
    const supplierFilter = args.supplier_filter ? String(args.supplier_filter).trim().toLowerCase() : null
    const monthsBack     = Math.min(24, Math.max(1, parseInt(String(args.months_back ?? 12), 10) || 12))
    const minInvoices    = Math.max(1, parseInt(String(args.min_invoices ?? 3), 10) || 3)
    const topN           = Math.min(50, Math.max(1, parseInt(String(args.top_n ?? 20), 10) || 20))
    const cutoff         = new Date(Date.now() - monthsBack * 30 * 86400_000).toISOString().slice(0, 10)

    let q = ctx.db
      .from('supplier_invoice_lines')
      .select('product_alias_id, supplier_name_snapshot, supplier_fortnox_number, quantity, total_excl_vat, price_per_unit, invoice_date, fortnox_invoice_number')
      .eq('business_id', ctx.businessId)
      .not('product_alias_id', 'is', null)
      .gte('invoice_date', cutoff)
    if (supplierFilter) q = q.ilike('supplier_name_snapshot', `%${supplierFilter}%`)
    const { data: lines, error } = await q.range(0, 49_999)
    if (error) return { error: 'query_failed', detail: error.message }
    if (!lines || lines.length === 0) {
      return { candidates: [], message: 'No matched invoice lines in window.', filters: { supplierFilter, monthsBack, minInvoices, topN } }
    }

    // alias → product lookup (batched)
    const aliasIds = Array.from(new Set(lines.map((l: any) => l.product_alias_id).filter(Boolean)))
    const aliasToProduct = new Map<string, string>()
    for (let i = 0; i < aliasIds.length; i += 100) {
      const slice = aliasIds.slice(i, i + 100)
      const { data: aRows } = await ctx.db.from('product_aliases').select('id, product_id').in('id', slice)
      for (const a of aRows ?? []) aliasToProduct.set((a as any).id, (a as any).product_id)
    }
    const productIds = Array.from(new Set(Array.from(aliasToProduct.values())))
    const productById = new Map<string, any>()
    for (let i = 0; i < productIds.length; i += 100) {
      const slice = productIds.slice(i, i + 100)
      const { data: pRows } = await ctx.db.from('products').select('id, name, category, default_supplier_name, invoice_unit').in('id', slice)
      for (const p of pRows ?? []) productById.set((p as any).id, p)
    }

    // Per-product aggregation: spend, line count, suppliers, monthly buckets, unit-price series.
    type Agg = {
      product_id: string; name: string; category: string | null; supplier: string | null; invoice_unit: string | null
      total_spend: number; line_count: number
      invoice_numbers: Set<string>; months: Set<string>; suppliers: Set<string>
      pricePoints: Array<{ date: string; unit_price: number }>
    }
    const agg = new Map<string, Agg>()
    for (const l of lines as any[]) {
      const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
      const prod = productById.get(pid); if (!prod) continue
      let row = agg.get(pid)
      if (!row) {
        row = { product_id: pid, name: prod.name, category: prod.category, supplier: prod.default_supplier_name ?? l.supplier_name_snapshot ?? null, invoice_unit: prod.invoice_unit,
                total_spend: 0, line_count: 0, invoice_numbers: new Set(), months: new Set(), suppliers: new Set(), pricePoints: [] }
        agg.set(pid, row)
      }
      const spend = l.total_excl_vat != null ? Number(l.total_excl_vat)
                  : (l.price_per_unit != null && l.quantity != null) ? Number(l.price_per_unit) * Number(l.quantity)
                  : 0
      row.total_spend += Number.isFinite(spend) ? spend : 0
      row.line_count  += 1
      if (l.fortnox_invoice_number)  row.invoice_numbers.add(String(l.fortnox_invoice_number))
      if (l.supplier_fortnox_number) row.suppliers.add(String(l.supplier_fortnox_number))
      if (l.invoice_date)            row.months.add(String(l.invoice_date).slice(0, 7))
      const up = l.price_per_unit != null ? Number(l.price_per_unit) : null
      if (up != null && Number.isFinite(up) && up > 0 && l.invoice_date) row.pricePoints.push({ date: l.invoice_date, unit_price: up })
    }

    // Score each candidate.
    type Scored = ReturnType<typeof scoreCandidate>
    function scoreCandidate(a: Agg) {
      const points = a.pricePoints.sort((x, y) => x.date.localeCompare(y.date))
      const prices = points.map(p => p.unit_price)
      const mean = prices.length ? prices.reduce((s, x) => s + x, 0) / prices.length : 0
      const variance = prices.length > 1 ? prices.reduce((s, x) => s + (x - mean) ** 2, 0) / (prices.length - 1) : 0
      const stdev = Math.sqrt(variance)
      const volatilityPct = mean > 0 ? (stdev / mean) * 100 : 0   // coefficient of variation
      // Trend: avg of last 25% vs avg of first 25%.
      let trendPct = 0
      if (points.length >= 4) {
        const qsize = Math.max(1, Math.floor(points.length / 4))
        const head = prices.slice(0, qsize).reduce((s, x) => s + x, 0) / qsize
        const tail = prices.slice(-qsize).reduce((s, x) => s + x, 0) / qsize
        if (head > 0) trendPct = ((tail - head) / head) * 100
      }
      const monthsCovered = a.months.size
      const purchaseConsistency = Math.min(1, monthsCovered / monthsBack)
      // Score: log-scaled spend × consistency × (1 + volatility bonus + trend bonus) × (1 + multi-supplier bonus)
      // - log10(spend+1): dampens so a 10× spend bump is ~+1 in score, not 10×
      // - consistency: bias toward items bought every month
      // - volatility bonus: capped at +0.75 (CV 50% → +0.75)
      // - trend bonus: only positive (upward price) trends boost; capped at +0.5
      // - multi-supplier bonus: if 2+ suppliers seen, +0.25 (consolidation savings)
      const volBonus  = Math.min(0.75, volatilityPct / 50 * 0.75)
      const trendBonus= Math.max(0, Math.min(0.5, trendPct / 20 * 0.5))
      const multiSupBonus = a.suppliers.size >= 2 ? 0.25 : 0
      const score = Math.log10(a.total_spend + 1) * (0.5 + purchaseConsistency) * (1 + volBonus + trendBonus + multiSupBonus)

      const reasons: string[] = []
      if (a.total_spend >= 50_000)        reasons.push(`Large spend: SEK ${Math.round(a.total_spend).toLocaleString('sv-SE')} over ${monthsCovered} month${monthsCovered === 1 ? '' : 's'}`)
      else if (a.total_spend >= 10_000)   reasons.push(`Mid-tier spend: SEK ${Math.round(a.total_spend).toLocaleString('sv-SE')}`)
      if (purchaseConsistency >= 0.8)     reasons.push(`Bought every month — predictable demand`)
      else if (purchaseConsistency >= 0.5)reasons.push(`Bought ${monthsCovered}/${monthsBack} months`)
      if (volatilityPct >= 15)            reasons.push(`Price varies ±${volatilityPct.toFixed(0)}% — locking in saves on volatility`)
      if (trendPct >= 8)                  reasons.push(`Price trending up ${trendPct.toFixed(0)}% — avtal protects against further increases`)
      if (a.suppliers.size >= 2)          reasons.push(`Bought from ${a.suppliers.size} suppliers — avtal would consolidate`)

      // Annualised projection if current pace continues, plus a 5%-discount savings illustration.
      const annualisedSpend = monthsCovered > 0 ? a.total_spend * (12 / monthsCovered) : a.total_spend
      const estSavings5pct  = annualisedSpend * 0.05

      return {
        product_id:        a.product_id,
        name:              a.name,
        category:          a.category,
        primary_supplier:  a.supplier,
        supplier_count:    a.suppliers.size,
        unit:              a.invoice_unit,
        total_spend:       Math.round(a.total_spend),
        annualised_spend_sek: Math.round(annualisedSpend),
        est_savings_at_5pct_avtal_sek: Math.round(estSavings5pct),
        invoice_count:     a.invoice_numbers.size,
        months_covered:    monthsCovered,
        purchase_consistency_pct: Math.round(purchaseConsistency * 100),
        avg_unit_price:    mean > 0 ? Math.round(mean * 100) / 100 : null,
        price_volatility_pct: Math.round(volatilityPct * 10) / 10,
        price_trend_pct:   Math.round(trendPct * 10) / 10,
        avtal_score:       Math.round(score * 100) / 100,
        why:               reasons,
      }
    }

    const qualifying = Array.from(agg.values()).filter(a => a.invoice_numbers.size >= minInvoices)
    const ranked = qualifying.map(scoreCandidate).sort((a, b) => b.avtal_score - a.avtal_score).slice(0, topN)

    return {
      filters: { supplierFilter, monthsBack, minInvoices, topN, since: cutoff },
      products_analysed: agg.size,
      products_qualifying: qualifying.length,
      lines_aggregated: lines.length,
      candidates: ranked,
      methodology: `avtal_score combines: spend (log-scaled), purchase consistency (months covered ÷ months in window), price volatility bonus (CV up to +75%), upward-price-trend bonus (up to +50%), and multi-supplier consolidation bonus (+25% when 2+ suppliers seen). Higher score = stronger contract candidate.`,
    }
  }

  if (name === 'get_product_price_history') {
    const productId = String(args.product_id ?? '').trim()
    if (!productId) return { error: 'invalid_args', detail: 'product_id required' }
    const limit = Math.min(100, Math.max(1, parseInt(String(args.limit ?? 30), 10) || 30))

    const { data: product } = await ctx.db
      .from('products')
      .select('id, name, category, default_supplier_name, invoice_unit')
      .eq('id', productId)
      .eq('business_id', ctx.businessId)
      .maybeSingle()
    if (!product) return { error: 'product_not_found', detail: `No product with id ${productId} for this business` }

    const { data: aliases } = await ctx.db
      .from('product_aliases')
      .select('id')
      .eq('product_id', productId)
    const aliasIds = (aliases ?? []).map((a: any) => a.id)
    if (aliasIds.length === 0) {
      return { product, history: [], message: 'Product has no aliases — never observed on an invoice.' }
    }

    const { data: history } = await ctx.db
      .from('supplier_invoice_lines')
      .select('invoice_date, fortnox_invoice_number, supplier_name_snapshot, raw_description, quantity, unit, price_per_unit, total_excl_vat, vat_rate')
      .eq('business_id', ctx.businessId)
      .in('product_alias_id', aliasIds)
      .order('invoice_date', { ascending: false })
      .limit(limit)

    const prices = (history ?? []).map((h: any) => h.price_per_unit).filter((p: any) => p != null).map(Number)
    return {
      product,
      observation_count: prices.length,
      min_price:         prices.length > 0 ? Math.min(...prices) : null,
      max_price:         prices.length > 0 ? Math.max(...prices) : null,
      avg_price:         prices.length > 0 ? prices.reduce((s: number, p: number) => s + p, 0) / prices.length : null,
      latest_price:      history?.[0]?.price_per_unit ?? null,
      latest_date:       history?.[0]?.invoice_date ?? null,
      history:           (history ?? []).map((h: any) => ({
        date:           h.invoice_date,
        invoice_number: h.fortnox_invoice_number,
        supplier:       h.supplier_name_snapshot,
        description:    h.raw_description,
        quantity:       h.quantity,
        unit:           h.unit,
        price_per_unit: h.price_per_unit,
        total:          h.total_excl_vat,
        vat_rate:       h.vat_rate,
      })),
    }
  }

  if (name === 'get_inventory_summary') {
    const [products, aliases, lines, extByStatus] = await Promise.all([
      ctx.db.from('products').select('*', { count: 'exact', head: true }).eq('business_id', ctx.businessId),
      ctx.db.from('product_aliases').select('*', { count: 'exact', head: true }).eq('business_id', ctx.businessId),
      ctx.db.from('supplier_invoice_lines').select('*', { count: 'exact', head: true }).eq('business_id', ctx.businessId),
      ctx.db.from('invoice_pdf_extractions').select('status').eq('business_id', ctx.businessId).range(0, 9999),
    ])
    const statusCounts: Record<string, number> = {}
    for (const r of (extByStatus.data ?? [])) statusCounts[(r as any).status] = (statusCounts[(r as any).status] ?? 0) + 1
    return {
      total_products:                  products.count ?? 0,
      total_aliases:                   aliases.count ?? 0,
      total_supplier_invoice_lines:    lines.count ?? 0,
      pdf_extractions_by_status:       statusCounts,
      catalogue_status:
        (products.count ?? 0) === 0 ? 'empty' :
        (statusCounts.pending ?? 0) > 0 ? 'partially_populated' :
        'populated',
    }
  }

  if (name === 'search_inventory_products') {
    const query = String(args.query ?? '').trim()
    if (!query) return { error: 'invalid_args', detail: 'query required' }
    const limit = Math.min(50, Math.max(1, parseInt(String(args.limit ?? 20), 10) || 20))

    // Match against products.name OR product_aliases.alias_text
    const { data: byName } = await ctx.db
      .from('products')
      .select('id, name, category, default_supplier_name, last_seen_price, last_seen_currency, last_seen_date')
      .eq('business_id', ctx.businessId)
      .ilike('name', `%${query}%`)
      .limit(limit)

    const { data: byAlias } = await ctx.db
      .from('product_aliases')
      .select('product_id, alias_text, supplier_name')
      .eq('business_id', ctx.businessId)
      .ilike('alias_text', `%${query}%`)
      .limit(limit)

    if ((byName?.length ?? 0) === 0 && (byAlias?.length ?? 0) === 0) {
      // Check whether the catalogue exists at all so we can give a useful answer
      const { count } = await ctx.db
        .from('products')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', ctx.businessId)
      if ((count ?? 0) === 0) {
        return {
          matches:           [],
          catalogue_status:  'empty',
          message:           'Inventory catalogue not yet populated. PDF extraction of supplier invoices may be pending — call get_inventory_summary for detail.',
        }
      }
      return { matches: [], catalogue_status: 'populated' }
    }

    // Aggregate alias hits onto their parent product
    const productIdsFromAliases = new Set((byAlias ?? []).map((a: any) => a.product_id))
    const extraProducts = productIdsFromAliases.size > 0
      ? await ctx.db
          .from('products')
          .select('id, name, category, default_supplier_name, last_seen_price, last_seen_currency, last_seen_date')
          .eq('business_id', ctx.businessId)
          .in('id', Array.from(productIdsFromAliases))
      : { data: [] }

    const allHits = new Map<string, any>()
    for (const p of (byName ?? [])) allHits.set(p.id, p)
    for (const p of (extraProducts.data ?? [])) allHits.set(p.id, p)

    return {
      matches: Array.from(allHits.values()).slice(0, limit).map((p: any) => ({
        product_id:        p.id,
        name:              p.name,
        category:          p.category,
        default_supplier:  p.default_supplier_name,
        last_seen_price:   p.last_seen_price,
        last_seen_currency: p.last_seen_currency,
        last_seen_date:    p.last_seen_date,
      })),
      catalogue_status: 'populated',
    }
  }

  if (name === 'get_invoice_lines') {
    const invNo = String(args.fortnox_invoice_number ?? '').trim()
    if (!invNo) return { error: 'invalid_args', detail: 'fortnox_invoice_number required' }

    const { data: lines } = await ctx.db
      .from('supplier_invoice_lines')
      .select('row_number, raw_description, article_number, quantity, unit, price_per_unit, total_excl_vat, vat_rate, matched_product_id, source')
      .eq('business_id', ctx.businessId)
      .eq('fortnox_invoice_number', invNo)
      .order('row_number')

    if (!lines || lines.length === 0) {
      // Check whether the invoice exists at the header level
      const { data: pdfExt } = await ctx.db
        .from('invoice_pdf_extractions')
        .select('status, attempts, error_message, rows_extracted')
        .eq('business_id', ctx.businessId)
        .eq('fortnox_invoice_number', invNo)
        .maybeSingle()
      return {
        invoice_number: invNo,
        lines:          [],
        line_count:     0,
        extraction_state: pdfExt ?? null,
        message: pdfExt
          ? `Invoice known but ${pdfExt.status === 'extracted' ? 'has no line items in cache' : `extraction is ${pdfExt.status}`}.`
          : 'Invoice not found in supplier_invoice_lines or invoice_pdf_extractions.',
      }
    }

    return {
      invoice_number: invNo,
      line_count:     lines.length,
      lines: lines.map((l: any) => ({
        row:             l.row_number,
        description:     l.raw_description,
        article_number:  l.article_number,
        quantity:        l.quantity,
        unit:            l.unit,
        price_per_unit:  l.price_per_unit,
        total_excl_vat:  l.total_excl_vat,
        vat_rate:        l.vat_rate,
        matched_product: l.matched_product_id,
        source:          l.source,
      })),
    }
  }

  return { error: 'unknown_tool', name }
}

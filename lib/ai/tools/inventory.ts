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
  name: 'search_inventory_products' | 'get_invoice_lines' | 'get_inventory_summary' | 'get_product_price_history',
  args: any,
): Promise<any> {
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

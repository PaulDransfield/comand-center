// app/api/reports/top-products/route.ts — top-products report (PDF/Word/PowerPoint).
//
// GET ?business_id=X&format=pdf|docx|pptx
//
// Optional filter params (all consumed by buildTopProductsSpec):
//   supplier_filter — substring match on supplier_name_snapshot
//   date_from / date_to — ISO YYYY-MM-DD
//   rank_by — 'spend' (default) | 'quantity' | 'invoice_count'
//   limit — top N (default 20, max 100)
//
// e.g. /api/reports/top-products?business_id=...&supplier_filter=martin+servera
//      &date_from=2026-01-01&rank_by=spend&limit=20&format=pdf
//
// Used by Ask CC via the generate_report tool — gives the AI a downloadable
// PDF/DOCX/PPTX for the same data its top_products_by_supplier tool returns.

import { NextRequest } from 'next/server'
import { serveReport } from '@/lib/reports/serve'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export function GET(req: NextRequest) { return serveReport(req, 'top-products') }

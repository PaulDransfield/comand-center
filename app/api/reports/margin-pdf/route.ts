// app/api/reports/margin-pdf/route.ts
//
// Back-compat shim — the canonical endpoint is now /api/reports/margin with
// ?format=pdf|docx|pptx. Redirect here so older links keep working.

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url  = new URL(req.url)
  const dest = new URL('/api/reports/margin', url.origin)
  dest.searchParams.set('format', 'pdf')
  const biz = url.searchParams.get('business_id')
  if (biz) dest.searchParams.set('business_id', biz)
  return NextResponse.redirect(dest, 307)
}

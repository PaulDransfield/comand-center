// app/api/reports/margin/route.ts
//
// Margin report download — one report-spec (lib/reports/margin-report.ts),
// three renderers chosen by ?format=:
//   pdf  → @react-pdf/renderer   (default)
//   docx → docx                  (Word)
//   pptx → pptxgenjs             (PowerPoint)
//
// GET /api/reports/margin?business_id=X&format=pdf|docx|pptx
//   Auth: user session (requireBusinessAccess) OR ADMIN_SECRET/CRON_SECRET.
//
// This is the surface the Ask CC chat bubble links to when the owner asks
// for a margin document.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAdminSecret, checkCronSecret } from '@/lib/admin/check-secret'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { buildMarginReportSpec } from '@/lib/reports/margin-report'
import { renderMarginPdf } from '@/components/reports/MarginReportPdf'
import { renderMarginDocx } from '@/lib/reports/margin-docx'
import { renderMarginPptx } from '@/lib/reports/margin-pptx'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const FORMATS = {
  pdf:  { mime: 'application/pdf', ext: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
} as const
type Format = keyof typeof FORMATS

export async function GET(req: NextRequest) {
  noStore()

  const url        = new URL(req.url)
  const businessId = (url.searchParams.get('business_id') ?? '').trim()
  const format     = (url.searchParams.get('format') ?? 'pdf').trim().toLowerCase() as Format
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!FORMATS[format]) return NextResponse.json({ error: `format must be one of: ${Object.keys(FORMATS).join(', ')}` }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id, name').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Auth: secret (server-side) OR user session scoped to this business.
  let orgId = biz.org_id
  if (!(checkAdminSecret(req) || checkCronSecret(req))) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const forbidden = requireBusinessAccess(auth, businessId)
    if (forbidden) return forbidden
    orgId = auth.orgId
  }

  // One AI call per document — quota-gated.
  const usage = await checkAndIncrementAiLimit(db, orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  let bytes: Buffer
  try {
    const spec = await buildMarginReportSpec(db, businessId, biz.name ?? 'Your restaurant')
    bytes = format === 'docx' ? await renderMarginDocx(spec)
          : format === 'pptx' ? await renderMarginPptx(spec)
          :                      await renderMarginPdf(spec)
  } catch (e: any) {
    return NextResponse.json({ error: `report generation failed: ${String(e?.message ?? e)}` }, { status: 500 })
  }

  const safeName = (biz.name ?? 'business').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const filename = `margin-report-${safeName}-${new Date().toISOString().slice(0, 10)}.${FORMATS[format].ext}`

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type':        FORMATS[format].mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store, max-age=0, must-revalidate',
    },
  })
}

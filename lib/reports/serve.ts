// lib/reports/serve.ts
//
// Shared handler behind every /api/reports/<type> route: auth → build the
// type's spec → render in the requested format → stream as a download.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAdminSecret, checkCronSecret } from '@/lib/admin/check-secret'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { buildReportSpec, type ReportType } from '@/lib/reports/builders'
import { renderReportPdf } from '@/components/reports/MarginReportPdf'
import { renderReportDocx } from '@/lib/reports/margin-docx'
import { renderReportPptx } from '@/lib/reports/margin-pptx'

const FORMATS = {
  pdf:  { mime: 'application/pdf', ext: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
} as const
type Format = keyof typeof FORMATS

export async function serveReport(req: NextRequest, type: ReportType): Promise<NextResponse> {
  const url        = new URL(req.url)
  const businessId = (url.searchParams.get('business_id') ?? '').trim()
  const format     = (url.searchParams.get('format') ?? 'pdf').trim().toLowerCase() as Format
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!FORMATS[format]) return NextResponse.json({ error: `format must be one of: ${Object.keys(FORMATS).join(', ')}` }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id, name').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  let orgId = biz.org_id
  if (!(checkAdminSecret(req) || checkCronSecret(req))) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const forbidden = requireBusinessAccess(auth, businessId)
    if (forbidden) return forbidden
    orgId = auth.orgId
  }

  const usage = await checkAndIncrementAiLimit(db, orgId)   // one AI call per document
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  let bytes: Buffer
  try {
    const spec = await buildReportSpec(db, type, businessId, biz.name ?? 'Your restaurant')
    bytes = format === 'docx' ? await renderReportDocx(spec)
          : format === 'pptx' ? await renderReportPptx(spec)
          :                      await renderReportPdf(spec)
  } catch (e: any) {
    return NextResponse.json({ error: `report generation failed: ${String(e?.message ?? e)}` }, { status: 500 })
  }

  const safeName = (biz.name ?? 'business').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const filename = `${type}-report-${safeName}-${new Date().toISOString().slice(0, 10)}.${FORMATS[format].ext}`
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type':        FORMATS[format].mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store, max-age=0, must-revalidate',
    },
  })
}

// app/api/reports/margin-pdf/route.ts
//
// PROTOTYPE — "make me a PDF on our margins + recommendations." Pulls the
// business's real closed-month P&L, has the AI write the summary +
// recommendations grounded in those numbers, renders a branded PDF, and
// streams it as a download.
//
// GET /api/reports/margin-pdf?business_id=X
//   Auth: user session (requireBusinessAccess) OR ADMIN_SECRET/CRON_SECRET
//   (so it can be tested server-side). Returns application/pdf attachment.
//
// This is the first instance of the report-spec → renderer pattern. Word
// (.docx via the installed `docx` lib) and PowerPoint (pptxgenjs) reuse the
// same spec from lib/reports/margin-report.ts.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAdminSecret, checkCronSecret } from '@/lib/admin/check-secret'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { buildMarginReportSpec } from '@/lib/reports/margin-report'
import { renderMarginPdf } from '@/components/reports/MarginReportPdf'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  noStore()

  const businessId = (new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Auth: secret (server-side test) OR user session scoped to this business.
  let orgId = biz.org_id
  const isSecret = checkAdminSecret(req) || checkCronSecret(req)
  if (!isSecret) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const forbidden = requireBusinessAccess(auth, businessId)
    if (forbidden) return forbidden
    orgId = auth.orgId
  }

  // One AI call per document — gate it (non-fatal: the spec soft-fails to a
  // deterministic summary, but we still respect the quota to avoid abuse).
  const usage = await checkAndIncrementAiLimit(db, orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  let pdf: Buffer
  try {
    const spec = await buildMarginReportSpec(db, businessId, biz.name ?? 'Your restaurant')
    pdf = await renderMarginPdf(spec)
  } catch (e: any) {
    return NextResponse.json({ error: `report generation failed: ${String(e?.message ?? e)}` }, { status: 500 })
  }

  const safeName = (biz.name ?? 'business').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const filename = `margin-report-${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store, max-age=0, must-revalidate',
    },
  })
}

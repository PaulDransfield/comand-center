// app/api/integrations/fortnox/invoice-pdf/route.ts
//
// On-demand "open the PDF for this supplier invoice" redirect.
//
// Why we need it:
//   - Fortnox's /supplierinvoices LIST endpoint omits SupplierInvoiceFileConnections.
//   - That field (which carries FileId) only appears on the DETAIL endpoint
//     /supplierinvoices/{GivenNumber}.
//   - We don't pre-fetch detail for every invoice in lists (would explode
//     to N extra Fortnox calls per dashboard load = 30-90 calls × ~200ms).
//   - Instead: this endpoint does a just-in-time detail fetch, extracts FileId,
//     302-redirects to the existing /api/integrations/fortnox/file proxy.
//
// User flow: click "View PDF" → spinner → PDF opens in new tab.
// First click is ~500ms-1s slower (detail fetch); subsequent clicks for the
// same invoice would be cacheable but we don't bother — Fortnox throttle is
// already covered, and N=1 click latency is fine.
//
// GET /api/integrations/fortnox/invoice-pdf?business_id=X&given_number=Y
//
// Outcomes:
//   - 302 → /api/integrations/fortnox/file?business_id=X&file_id=Y  (PDF found)
//   - 404 → no PDF attached to this invoice in Fortnox
//   - 502 → Fortnox detail fetch failed
//   - 401/403 → standard auth errors

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { decrypt }                      from '@/lib/integrations/encryption'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 30

const FORTNOX_API = 'https://api.fortnox.se/3'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId  = String(url.searchParams.get('business_id')  ?? '').trim()
  const givenNumber = String(url.searchParams.get('given_number') ?? '').trim()
  if (!businessId || !givenNumber) {
    return NextResponse.json({ error: 'business_id and given_number required' }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify ownership
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Connected (or recoverable-state) Fortnox integration
  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'error', 'warning'])
    .limit(1)
    .maybeSingle()

  if (!integ?.credentials_enc) {
    return NextResponse.json({ error: 'No Fortnox integration' }, { status: 404 })
  }

  let creds: any
  try { creds = JSON.parse(decrypt(integ.credentials_enc) ?? '{}') } catch {
    return NextResponse.json({ error: 'Failed to decrypt credentials' }, { status: 500 })
  }
  const accessToken = String(creds?.access_token ?? '')
  if (!accessToken) {
    return NextResponse.json({ error: 'No access token' }, { status: 500 })
  }

  // Fetch invoice detail (with 429 retry baked in)
  const detailUrl = `${FORTNOX_API}/supplierinvoices/${encodeURIComponent(givenNumber)}`
  const res = await fortnoxFetch(detailUrl, accessToken)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return NextResponse.json({
      error:  `Fortnox detail fetch failed: HTTP ${res.status}`,
      detail: text.slice(0, 200),
    }, { status: 502 })
  }
  const body: any = await res.json().catch(() => null)
  const fileConnections = body?.SupplierInvoice?.SupplierInvoiceFileConnections
                       ?? body?.SupplierInvoiceFileConnections
                       ?? []
  const fileId = Array.isArray(fileConnections) && fileConnections.length > 0
    ? String(fileConnections[0]?.FileId ?? '')
    : ''

  if (!fileId) {
    return NextResponse.json({
      error:   'no_pdf_attached',
      message: 'This supplier invoice has no PDF attached in Fortnox.',
    }, { status: 404 })
  }

  // 302 to the existing PDF proxy. Filename is best-effort.
  const filename = `invoice-${givenNumber}.pdf`
  const proxyUrl =
    `/api/integrations/fortnox/file?business_id=${encodeURIComponent(businessId)}` +
    `&file_id=${encodeURIComponent(fileId)}` +
    `&filename=${encodeURIComponent(filename)}`

  return NextResponse.redirect(new URL(proxyUrl, req.url), { status: 302 })
}

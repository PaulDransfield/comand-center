// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { validateOrgNr, normaliseOrgNr } from '@/lib/sweden/orgnr'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { business_id, name, city, type } = body
  if (!business_id) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  // Build the update patch. org_number is optional + nullable; validate
  // checksum when present, allow null/empty to clear the field.
  const patch: Record<string, any> = { name, city, type }
  if (Object.prototype.hasOwnProperty.call(body, 'org_number')) {
    const raw = body.org_number
    if (raw == null || String(raw).trim() === '') {
      patch.org_number = null
    } else {
      const v = validateOrgNr(raw)
      if (!v.ok) {
        return NextResponse.json({ error: `Organisationsnummer: ${v.error}` }, { status: 400 })
      }
      patch.org_number = v.value
    }
  }

  const db = createAdminClient()
  const { error } = await db.from('businesses')
    .update(patch)
    .eq('id', business_id)
    .eq('org_id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

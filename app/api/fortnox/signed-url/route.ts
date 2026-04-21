// app/api/fortnox/signed-url/route.ts
// Returns a short-lived signed URL for a PDF so the review modal can
// iframe-preview it without exposing the private bucket.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: upload } = await db
    .from('fortnox_uploads')
    .select('pdf_storage_path')
    .eq('id', id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!upload) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: signed, error } = await db.storage
    .from('fortnox-pdfs')
    .createSignedUrl(upload.pdf_storage_path, 60 * 10)   // 10-minute preview window
  if (error || !signed) return NextResponse.json({ error: error?.message ?? 'Sign failed' }, { status: 500 })

  return NextResponse.json({ url: signed.signedUrl })
}

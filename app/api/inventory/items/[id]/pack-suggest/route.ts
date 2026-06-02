// app/api/inventory/items/[id]/pack-suggest/route.ts
//
// GET — best-effort pack_size + base_unit suggestion parsed from the
// product name. Used by the catalogue detail page to surface a "We
// detected 4,1 kg = 4100 g — apply?" hint when the owner hasn't set
// pack values yet.
//
// Returns the parsed suggestion + the substring it matched so the UI
// can show "4,1 kg" highlighted.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { parseProductPackSize } from '@/lib/inventory/unit-conversion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: p } = await db
    .from('products')
    .select('id, business_id, name, pack_size, base_unit, invoice_unit')
    .eq('id', params.id)
    .maybeSingle()
  if (!p) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, p.business_id)
  if (forbidden) return forbidden

  // Phase A — parser does name-first, invoice_unit-fallback in one call.
  // `suggestion.source` distinguishes them so the UI can render
  // "from product name (4,1 kg)" vs "from invoice unit (KG)".
  const suggestion = parseProductPackSize(p.name, p.invoice_unit)
  return NextResponse.json({
    current:   { pack_size: p.pack_size, base_unit: p.base_unit },
    suggested: suggestion,    // null when nothing parseable
  }, { headers: { 'Cache-Control': 'no-store' } })
}

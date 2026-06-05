// app/api/inventory/items/[id]/ai-fill/route.ts
//
// POST — ask Haiku to derive item-detail fields from the linked
// supplier_articles row. Returns SUGGESTIONS only; the UI shows
// old-vs-new and the owner applies.
//
// The core logic lives in lib/inventory/ai-fill-product.ts so the bulk
// endpoint (POST /api/inventory/items/ai-fill-bulk) uses the same prompt
// + apply logic — single source of truth for the AI-fill behaviour.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { aiFillProduct } from '@/lib/inventory/ai-fill-product'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()

  const { data: product } = await db
    .from('products')
    .select('business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  const result = await aiFillProduct(db, params.id)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 })
  }
  return NextResponse.json({
    ok:             true,
    suggestion:     result.suggestion,
    source_article: result.source_article,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

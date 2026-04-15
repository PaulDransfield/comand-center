// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/integrations/encryption'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { provider, api_key, org_id, business_id } = await req.json()
    if (!provider || !api_key || !org_id) return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })

    const db = createAdminClient()
    const encrypted = encrypt(api_key)

    // Upsert integration — always tied to business_id
    const { data: existing } = await db
      .from('integrations')
      .select('id')
      .eq('org_id', org_id)
      .eq('provider', provider)
      .eq('business_id', business_id)
      .maybeSingle()

    let integrationId: string

    if (existing) {
      await db.from('integrations').update({
        credentials_enc: encrypted,
        status:          'connected',
        last_error:      null,
        updated_at:      new Date().toISOString(),
      }).eq('id', existing.id)
      integrationId = existing.id
    } else {
      const { data } = await db.from('integrations').insert({
        org_id,
        business_id,
        provider,
        credentials_enc: encrypted,
        status:          'connected',
        connected_at:    new Date().toISOString(),
      }).select('id').single()
      integrationId = data.id
    }

    return NextResponse.json({ ok: true, integration_id: integrationId })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

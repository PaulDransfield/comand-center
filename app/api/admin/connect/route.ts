// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/integrations/encryption'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { checkAdminSecret } from '@/lib/admin/check-secret'
export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { provider, api_key, org_id, business_id, department } = await req.json()
    if (!provider || !api_key || !org_id) return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })

    const db = createAdminClient()
    const encrypted = encrypt(api_key)

    // Inzii: one row per department — upsert on org+provider+business+department
    // Other providers: one row per provider per business
    let existingQuery = db
      .from('integrations')
      .select('id')
      .eq('org_id', org_id)
      .eq('provider', provider)
      .eq('business_id', business_id)

    if (provider === 'inzii' && department) {
      existingQuery = existingQuery.eq('department', department)
    }

    const { data: existing } = await existingQuery.maybeSingle()

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
      const insertRow: any = {
        org_id,
        business_id,
        provider,
        credentials_enc: encrypted,
        status:          'connected',
      }
      if (provider === 'inzii' && department) insertRow.department = department

      const { data, error: insertErr } = await db.from('integrations').insert(insertRow).select('id').single()
      if (insertErr) throw new Error(insertErr.message)
      if (!data) throw new Error('Insert returned no data — check that M005 migration has been run (ALTER TABLE integrations ADD COLUMN IF NOT EXISTS department TEXT)')
      integrationId = data.id
    }

    await recordAdminAction(db, {
      action:        existing ? ADMIN_ACTIONS.INTEGRATION_KEY_EDIT : ADMIN_ACTIONS.INTEGRATION_ADD,
      orgId:         org_id,
      integrationId: integrationId,
      targetType:    'integration',
      targetId:      integrationId,
      payload:       { provider, business_id, department: department || null },
      req,
    })

    return NextResponse.json({ ok: true, integration_id: integrationId })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

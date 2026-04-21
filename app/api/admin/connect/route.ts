// @ts-nocheck
// app/api/admin/connect/route.ts
//
// Admin-only connect of an integration (API key + provider) to a
// business. Two layers of auth:
//   1. ADMIN_SECRET must be valid (checkAdminSecret)
//   2. The supplied (org_id, business_id) pair is verified against the
//      DB before we store credentials — blocks the attack where an
//      admin-secret holder swaps org_id to write to another tenant.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { encrypt } from '@/lib/integrations/encryption'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { requireAdmin } from '@/lib/admin/require-admin'

export const dynamic     = 'force-dynamic'
export const runtime     = 'nodejs'
export const maxDuration = 10

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any))
  const { provider, api_key, org_id, business_id, department } = body
  if (!provider || !api_key || !org_id || !business_id) {
    return NextResponse.json({ error: 'Missing required fields (provider, api_key, org_id, business_id)' }, { status: 400 })
  }

  // Admin secret + (org, business) scope check. Returns a NextResponse
  // on failure; otherwise { ok, orgId, businessId }.
  const guard = await requireAdmin(req, { orgId: org_id, businessId: business_id })
  if ('ok' in guard === false) return guard as NextResponse

  try {
    const db        = createAdminClient()
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

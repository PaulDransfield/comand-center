// @ts-nocheck
// /api/admin/departments — create/list department definitions for a business
// POST: auto-populate from existing Inzii integrations (one dept per integration.department)
// GET:  list existing department records for a business

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

// Preset colour palette — auto-assigned in order, cycling if more than 8 depts
const PALETTE = [
  '#f59e0b', '#10b981', '#ef4444', '#3b82f6',
  '#8b5cf6', '#06b6d4', '#f97316', '#ec4899',
  '#84cc16', '#14b8a6', '#a855f7', '#0ea5e9',
]

// Known dept colours from the brand constants — same as lib/constants/colors.ts
const KNOWN_COLORS: Record<string, string> = {
  'Bella':          '#f59e0b',
  'Chilango':       '#10b981',
  'Carne':          '#ef4444',
  'Runner':         '#8b5cf6',
  'Administration': '#6366f1',
  'Ölbaren':        '#3b82f6',
  'Olbaren':        '#3b82f6',
  'Bubbel & Brus':  '#06b6d4',
  'Rosalis Select': '#f97316',
  'Kök':            '#ec4899',
  'Servering':      '#14b8a6',
  'Bar':            '#84cc16',
  'Kitchen':        '#ec4899',
  'Front of House': '#14b8a6',
}

export async function GET(req: NextRequest) {
  const db         = createAdminClient()
  const businessId = req.nextUrl.searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const { data, error } = await db
    .from('departments')
    .select('id, name, color, sort_order, created_at')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ departments: data ?? [] })
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db = createAdminClient()
  const body = await req.json()
  const { org_id, business_id, action, departments: manualDepts } = body

  if (!org_id || !business_id) return NextResponse.json({ error: 'org_id and business_id required' }, { status: 400 })

  if (action === 'auto') {
    // Auto-populate: read Inzii integrations for this business, create one dept per integration.department
    const { data: integrations } = await db
      .from('integrations')
      .select('department')
      .eq('org_id', org_id)
      .eq('business_id', business_id)
      .eq('provider', 'inzii')
      .not('department', 'is', null)

    if (!integrations?.length) {
      return NextResponse.json({ error: 'No Inzii departments found for this business. Add Inzii departments first.' }, { status: 404 })
    }

    const rows = integrations.map((integ, i) => ({
      org_id,
      business_id,
      name:       integ.department,
      color:      KNOWN_COLORS[integ.department] ?? PALETTE[i % PALETTE.length],
      sort_order: i,
    }))

    // Upsert — if dept already exists (same name+business), update color/order
    const { data, error } = await db
      .from('departments')
      .upsert(rows, { onConflict: 'business_id,name' })
      .select('id, name, color, sort_order')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await recordAdminAction(db, { action: ADMIN_ACTIONS.DEPT_SETUP, orgId: org_id, targetType: 'business', targetId: business_id, payload: { created: rows.length, names: rows.map(r => r.name) }, req })
    return NextResponse.json({ ok: true, departments: data ?? [], created: rows.length })
  }

  if (action === 'update' && manualDepts) {
    // Update color/order for existing depts
    const results = await Promise.all(
      manualDepts.map((d: any) =>
        db.from('departments')
          .update({ color: d.color, sort_order: d.sort_order })
          .eq('id', d.id)
          .eq('business_id', business_id)
      )
    )
    const err = results.find(r => r.error)
    if (err?.error) return NextResponse.json({ error: err.error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const db   = createAdminClient()
  const body = await req.json()
  const { id, business_id } = body
  if (!id || !business_id) return NextResponse.json({ error: 'id and business_id required' }, { status: 400 })

  const { error } = await db
    .from('departments')
    .delete()
    .eq('id', id)
    .eq('business_id', business_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// app/api/invoices/route.ts
// GET  — list invoices with filters (status, business, date range)
// POST — create invoice manually
// PATCH — update status (mark paid, snooze)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

async function getAuth(req: NextRequest) {
  const cookieName  = 'sb-llzmixkrysduztsvmfzi-auth-token'
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return null
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(accessToken)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    if (!m) return null
    return { userId: user.id, orgId: m.org_id }
  } catch { return null }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const status     = searchParams.get('status')  // 'unpaid'|'paid'|'overdue'|'all'
  const from       = searchParams.get('from')
  const to         = searchParams.get('to')

  const db = createAdminClient()
  // Use the view which calculates is_overdue and days_until_due dynamically
  let q = db
    .from('invoices_with_status')
    .select('*, businesses(name, city)')
    .eq('org_id', auth.orgId)
    .order('due_date', { ascending: true })

  if (businessId) q = q.eq('business_id', businessId)
  if (from)       q = q.gte('due_date', from)
  if (to)         q = q.lte('due_date', to)

  if (status === 'overdue') {
    q = q.lt('due_date', new Date().toISOString().slice(0,10))
         .is('paid_date', null)
         .eq('status', 'unpaid')
  } else if (status && status !== 'all') {
    q = q.eq('status', status)
  }

  const { data, error } = await q.limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { business_id, vendor, amount, due_date, invoice_date, invoice_number, description, category, vat_amount, notes, line_items, doc_url } = body

  if (!business_id || !vendor || !amount) {
    return NextResponse.json({ error: 'business_id, vendor and amount required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data, error } = await db
    .from('invoices')
    .insert({
      org_id:         auth.orgId,
      business_id,
      vendor,
      amount:         Number(amount),
      vat_amount:     Number(vat_amount ?? 0),
      due_date:       due_date || null,
      invoice_date:   invoice_date || null,
      invoice_number: invoice_number || null,
      description:    description || null,
      category:       category || 'other',
      notes:          notes || null,
      status:         'unpaid',
      source:         'manual',
      line_items:     line_items ?? [],
      doc_url:        doc_url ?? null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function PATCH(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id, action, snoozed_until, notes } = await req.json()
  if (!id || !action) return NextResponse.json({ error: 'id and action required' }, { status: 400 })

  const db = createAdminClient()

  let update: Record<string, any> = { updated_at: new Date().toISOString() }

  if (action === 'mark_paid') {
    update.status    = 'paid'
    update.paid_date = new Date().toISOString().slice(0, 10)
  } else if (action === 'snooze') {
    update.status       = 'snoozed'
    update.snoozed_until = snoozed_until
  } else if (action === 'unsnooze') {
    update.status        = 'unpaid'
    update.snoozed_until = null
  } else if (action === 'cancel') {
    update.status = 'cancelled'
  }

  if (notes) update.notes = notes

  const { data, error } = await db
    .from('invoices')
    .update(update)
    .eq('id', id)
    .eq('org_id', auth.orgId)  // safety: can only update own org's invoices
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = createAdminClient()

  // Get the invoice first to delete its file from storage
  const { data: inv } = await db
    .from('invoices')
    .select('doc_url, org_id')
    .eq('id', id)
    .eq('org_id', auth.orgId)
    .single()

  if (inv?.doc_url) {
    try {
      // Extract path from public URL and delete from storage
      const urlParts = inv.doc_url.split('/documents/')
      if (urlParts[1]) {
        await db.storage.from('documents').remove([urlParts[1]])
      }
    } catch { /* ignore storage errors */ }
  }

  const { error } = await db
    .from('invoices')
    .delete()
    .eq('id', id)
    .eq('org_id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

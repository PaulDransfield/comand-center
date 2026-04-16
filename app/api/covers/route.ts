// @ts-nocheck
// app/api/covers/route.ts
// GET  — fetch covers for a business/period
// POST — manually add or update covers for a day
// PUT  — trigger POS sync for a business

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'

const getAuth = getRequestAuth

// GET — fetch covers
export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const businessId = searchParams.get('business_id')
  const from       = searchParams.get('from') ?? new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10)
  const to         = searchParams.get('to')   ?? new Date().toISOString().slice(0,10)
  const period     = searchParams.get('period') // 'breakfast'|'lunch'|'dinner'|'takeaway'|'catering'|null

  const db = createAdminClient()
  let q = db.from('covers')
    .select('*')
    .eq('org_id', auth.orgId)
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })

  if (businessId) q = q.eq('business_id', businessId)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Fill all days in range
  const allDays: any[] = []
  const startD = new Date(from)
  const endD   = new Date(to)
  const dataMap: Record<string, any> = {}
  for (const row of data ?? []) dataMap[row.date] = row

  for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0,10)
    allDays.push(dataMap[ds] ?? {
      date: ds, total: 0, revenue: 0, revenue_per_cover: 0,
      breakdown: {}, source: null, is_closed: true
    })
  }

  return NextResponse.json(allDays.sort((a,b) => b.date.localeCompare(a.date)))
}

// POST — add/update covers manually
export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json()
  const { business_id, date, breakfast=0, lunch=0, dinner=0, takeaway=0, catering=0, other=0, revenue=0, notes } = body

  if (!business_id || !date) {
    return NextResponse.json({ error: 'business_id and date required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data, error } = await db
    .from('covers')
    .upsert({
      org_id:     auth.orgId,
      business_id,
      date,
      breakfast:  Number(breakfast),
      lunch:      Number(lunch),
      dinner:     Number(dinner),
      takeaway:   Number(takeaway),
      catering:   Number(catering),
      other:      Number(other),
      revenue:    Number(revenue),
      notes:      notes ?? null,
      source:     'manual',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'business_id,date' })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// PUT — trigger POS sync
export async function PUT(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { business_id, from, to } = await req.json()
  if (!business_id) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Get POS connection for this business
  const { data: pos } = await db
    .from('pos_connections')
    .select('*')
    .eq('business_id', business_id)
    .eq('status', 'connected')
    .single()

  if (!pos) {
    return NextResponse.json({ error: 'No POS connected for this business' }, { status: 404 })
  }

  try {
    // Dynamically load the adapter
    const { getAdapter } = await import('@/lib/pos/adapter')
    const adapter = getAdapter(pos.pos_system)
    if (!adapter) {
      return NextResponse.json({ error: `Unknown POS system: ${pos.pos_system}` }, { status: 400 })
    }

    // Decrypt credentials
    if (!pos.credentials_enc) {
      return NextResponse.json({ error: 'No credentials stored for this POS' }, { status: 400 })
    }
    const credentials = JSON.parse(decrypt(pos.credentials_enc!))
    const config      = pos.config ?? {}

    const fromDate = from ?? new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10)
    const toDate   = to   ?? new Date().toISOString().slice(0,10)

    // Fetch from POS
    const covers = await adapter.fetchCovers(credentials, config, fromDate, toDate)

    if (!covers.length) {
      return NextResponse.json({ ok: true, synced: 0, message: 'No covers returned from POS' })
    }

    // Upsert into covers table
    const rows = covers.map(c => ({
      org_id:     auth.orgId,
      business_id,
      date:       c.date,
      breakfast:  c.breakfast,
      lunch:      c.lunch,
      dinner:     c.dinner,
      takeaway:   c.takeaway,
      catering:   c.catering,
      other:      c.other,
      revenue:    c.revenue,
      source:     c.source,
      updated_at: new Date().toISOString(),
    }))

    const { error } = await db.from('covers').upsert(rows, { onConflict: 'business_id,date' })
    if (error) throw error

    // Update last_sync_at
    await db.from('pos_connections')
      .update({ last_sync_at: new Date().toISOString(), status: 'connected', last_error: null })
      .eq('id', pos.id)

    return NextResponse.json({ ok: true, synced: covers.length })
  } catch (err: any) {
    // Update error status
    await db.from('pos_connections')
      .update({ status: 'error', last_error: err.message })
      .eq('business_id', business_id)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

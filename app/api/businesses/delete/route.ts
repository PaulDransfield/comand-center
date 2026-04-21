// @ts-nocheck
// app/api/businesses/delete/route.ts
//
// Deletes a business (soft or permanent). Permanent deletion cascades
// through nine child tables before dropping the business row itself.
//
// Previous version silently swallowed every child-table delete error
// (.catch(() => {})) — meaning a foreign-key violation, permission
// error, or schema drift would leave orphan rows and we'd never see it.
// Now each child-table failure is captured to Sentry with context, and
// if any of them fail we abort before dropping the business row so the
// caller gets a clear 500 instead of a misleading 200.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { captureError } from '@/lib/monitoring/sentry'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

const getAuth = getRequestAuth

const CHILD_TABLES = [
  'tracker_data', 'covers', 'staff_logs', 'revenue_logs',
  'forecasts', 'budgets', 'pk_sale_forecasts',
  'financial_logs', 'anomaly_alerts',
]

export async function POST(req: NextRequest) {
  try {
    const auth = await getAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { id, permanent } = await req.json()
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const db = createAdminClient()
    const { data: biz } = await db.from('businesses')
      .select('id, name')
      .eq('id', id)
      .eq('org_id', auth.orgId)
      .maybeSingle()
    if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

    if (!permanent) {
      const { error } = await db.from('businesses')
        .update({ is_active: false })
        .eq('id', id)
        .eq('org_id', auth.orgId)
      if (error) {
        captureError(error, { route: 'businesses/delete', op: 'soft', business_id: id, org_id: auth.orgId })
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ ok: true, deactivated: true })
    }

    // Permanent delete — fail loudly on any child-table error instead
    // of orphaning rows. Previously: catch(() => {}) suppressed everything.
    const failures: string[] = []
    for (const table of CHILD_TABLES) {
      const { error } = await db.from(table).delete().eq('business_id', id)
      if (error) {
        captureError(error, { route: 'businesses/delete', op: 'cascade', table, business_id: id, org_id: auth.orgId })
        failures.push(`${table}: ${error.message}`)
      }
    }

    // integrations get unlinked rather than deleted — the admin may
    // want to re-attach them to a different business.
    const { error: unlinkErr } = await db.from('integrations')
      .update({ business_id: null })
      .eq('business_id', id)
    if (unlinkErr) {
      captureError(unlinkErr, { route: 'businesses/delete', op: 'integration_unlink', business_id: id, org_id: auth.orgId })
      failures.push(`integrations unlink: ${unlinkErr.message}`)
    }

    if (failures.length) {
      return NextResponse.json({
        error: 'Delete aborted — child cleanup failed',
        failures,
      }, { status: 500 })
    }

    const { error: dropErr } = await db.from('businesses').delete().eq('id', id).eq('org_id', auth.orgId)
    if (dropErr) {
      captureError(dropErr, { route: 'businesses/delete', op: 'drop', business_id: id, org_id: auth.orgId })
      return NextResponse.json({ error: dropErr.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, deleted: true })
  } catch (e: any) {
    captureError(e, { route: 'businesses/delete', op: 'handler_catch' })
    return NextResponse.json({ error: e?.message ?? 'Unknown error' }, { status: 500 })
  }
}

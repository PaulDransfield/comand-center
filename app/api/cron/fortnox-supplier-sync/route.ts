// app/api/cron/fortnox-supplier-sync/route.ts
//
// Daily incremental sync of Fortnox supplier invoices into the local
// fortnox_supplier_invoices cache (M098). User-facing surfaces read
// the cache; this worker reconciles with Fortnox in the background.
//
// Strategy:
//   - For each business with a connected Fortnox integration:
//     1. Look up last_synced_at from fortnox_sync_state
//     2. Pull /supplierinvoices?fromdate=(last - 24h)&todate=today
//     3. UPSERT each into fortnox_supplier_invoices
//     4. Update fortnox_sync_state with new cursor + rows count
//   - First run (no state row): backfill last 12 months
//
// Cost model: 1 Fortnox call per business per day (plus pagination if
// the customer has >500 invoices in the sync window — rare). Eliminates
// the per-render Fortnox traffic that breaks at 3+ customers.

import { NextRequest, NextResponse }    from 'next/server'
import { createAdminClient }            from '@/lib/supabase/server'
import { checkCronSecret }              from '@/lib/admin/check-secret'
import { log }                          from '@/lib/log/structured'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken }   from '@/lib/fortnox/api/auth'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 60

const FORTNOX_API     = 'https://api.fortnox.se/3'
const DEFAULT_BACKFILL_MONTHS = 12   // first run pulls last year
const RESUME_OVERLAP_DAYS     = 1    // re-pull last day to catch late-arriving rows

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('fortnox-supplier-sync', async () => {

  const started = Date.now()
  const db = createAdminClient()

  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, status, businesses(name)')
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'warning'])
  if (!integrations?.length) {
    return NextResponse.json({ ok: true, businesses_synced: 0, message: 'no active fortnox integrations' })
  }

  let synced = 0
  const errors: string[] = []
  let totalRowsUpserted = 0

  for (const integ of integrations) {
    const bizName = ((integ.businesses as any)?.name) ?? '(unnamed)'
    if (!integ.business_id) continue
    try {
      const accessToken = await getFreshFortnoxAccessToken(db, integ.org_id, integ.business_id)
      if (!accessToken) {
        errors.push(`${bizName}: no token (integration likely in needs_reauth)`)
        continue
      }

      // Find the cursor — last successful sync's to-date.
      const { data: state } = await db
        .from('fortnox_sync_state')
        .select('last_cursor_date')
        .eq('business_id', integ.business_id)
        .eq('resource', 'supplier_invoices')
        .maybeSingle()

      const today = new Date()
      let fromIso: string
      if (state?.last_cursor_date) {
        // Resume — go back RESUME_OVERLAP_DAYS to catch back-dated entries.
        const d = new Date(state.last_cursor_date)
        d.setUTCDate(d.getUTCDate() - RESUME_OVERLAP_DAYS)
        fromIso = d.toISOString().slice(0, 10)
      } else {
        // First-time backfill.
        const d = new Date(today)
        d.setUTCMonth(d.getUTCMonth() - DEFAULT_BACKFILL_MONTHS)
        fromIso = d.toISOString().slice(0, 10)
      }
      const toIso = today.toISOString().slice(0, 10)

      // Paginate /supplierinvoices in chunks of 500.
      let rowsUpserted = 0
      let page = 1
      while (true) {
        // No `filter=` param — Fortnox returns all non-cancelled invoices
        // by default. `filter=all` is NOT a valid value (valid options:
        // cancelled, fullypaid, unpaid, unpaidoverdue, unbooked, bookkept).
        // Sending an invalid filter value triggers HTTP 400 ("Ett ogiltigt
        // filter har använts", code 2000587).
        const url = `${FORTNOX_API}/supplierinvoices?fromdate=${fromIso}&todate=${toIso}&limit=500&page=${page}`
        const res = await fortnoxFetch(url, accessToken, { accept: 'application/json' })
        if (!res.ok) {
          const t = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`)
        }
        const data = await res.json()
        const invoices = (data.SupplierInvoices ?? []) as any[]
        if (invoices.length === 0) break

        const upsertRows = invoices.map(inv => ({
          org_id:           integ.org_id,
          business_id:      integ.business_id,
          given_number:     String(inv.GivenNumber ?? inv.InvoiceNumber ?? ''),
          invoice_number:   inv.InvoiceNumber ? String(inv.InvoiceNumber) : null,
          supplier_name:    inv.SupplierName ?? '(unknown)',
          supplier_number:  inv.SupplierNumber ? String(inv.SupplierNumber) : null,
          supplier_normalised: String(inv.SupplierName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''),
          invoice_date:     inv.InvoiceDate     ?? inv.BookKeepingDate ?? null,
          bookkeeping_date: inv.BookKeepingDate ?? null,
          due_date:         inv.DueDate         ?? null,
          total:            inv.Total          != null ? Number(inv.Total)         : null,
          currency:         inv.Currency         ?? null,
          vat:              inv.VAT             != null ? Number(inv.VAT)            : null,
          balance:          inv.Balance         != null ? Number(inv.Balance)        : null,
          final_pay_date:   inv.FinalPayDate     ?? null,
          voucher_series:   inv.VoucherSeries    ?? null,
          voucher_number:   inv.VoucherNumber   != null ? Number(inv.VoucherNumber)  : null,
          comments:         inv.Comments         ?? null,
          cancelled:        Boolean(inv.Cancelled),
          raw_data:         inv,
          last_synced_at:   new Date().toISOString(),
        })).filter(r => r.given_number && r.invoice_date)

        if (upsertRows.length > 0) {
          // unique constraint (business_id, given_number) — full unique
          // (not partial) so onConflict works cleanly.
          const { error: upErr } = await db
            .from('fortnox_supplier_invoices')
            .upsert(upsertRows, { onConflict: 'business_id,given_number' })
          if (upErr) throw new Error(`upsert failed: ${upErr.message}`)
          rowsUpserted += upsertRows.length
        }

        if (invoices.length < 500) break
        page++
        if (page > 50) break  // safety: 50 pages × 500 = 25,000 invoices; far above any realistic single sync
      }

      // Persist cursor for next run.
      await db
        .from('fortnox_sync_state')
        .upsert({
          business_id:       integ.business_id,
          resource:          'supplier_invoices',
          last_synced_at:    new Date().toISOString(),
          last_cursor_date:  toIso,
          rows_synced:       rowsUpserted,
          last_error:        null,
        }, { onConflict: 'business_id,resource' })

      totalRowsUpserted += rowsUpserted
      synced++
      log.info('fortnox_supplier_sync biz ok', {
        route:        'cron/fortnox-supplier-sync',
        business_id:  integ.business_id,
        rows_upserted: rowsUpserted,
        from_date:    fromIso,
        to_date:      toIso,
      })
    } catch (e: any) {
      const msg = `${bizName}: ${e?.message ?? String(e)}`
      errors.push(msg)
      // Record the error on sync_state so an ops dashboard can surface it.
      try {
        await db.from('fortnox_sync_state').upsert({
          business_id:    integ.business_id,
          resource:       'supplier_invoices',
          last_synced_at: new Date().toISOString(),
          last_error:     String(e?.message ?? e).slice(0, 500),
        }, { onConflict: 'business_id,resource' })
      } catch {}
      log.error('fortnox_supplier_sync biz failed', {
        route:        'cron/fortnox-supplier-sync',
        business_id:  integ.business_id,
        error:        e?.message ?? String(e),
      })
    }
  }

  log.info('fortnox_supplier_sync complete', {
    route:               'cron/fortnox-supplier-sync',
    duration_ms:         Date.now() - started,
    businesses_synced:   synced,
    businesses_failed:   errors.length,
    total_rows_upserted: totalRowsUpserted,
  })

  return NextResponse.json({
    ok:                synced > 0 || errors.length === 0,
    businesses_synced: synced,
    total_rows:        totalRowsUpserted,
    errors:            errors.length > 0 ? errors.slice(0, 10) : undefined,
    timestamp:         new Date().toISOString(),
  })
  })
}

export const GET = POST

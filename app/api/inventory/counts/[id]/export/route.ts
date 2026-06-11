// app/api/inventory/counts/[id]/export/route.ts
//
// GET — download a stock count as an Excel (.xlsx) workbook.
//
// The file carries:
//   · a metadata block (business, location, date, WHO counted it,
//     started/completed timestamps, how long it took, total value)
//   · a line table (product, category, counted qty + unit, the unit
//     price + line value FROZEN at count time, notes)
//
// "Who counted it" comes from stock_counts.created_by → public.users.
// Frozen snapshot fields (quantity / unit_price_at_count /
// line_value_at_count) are what the count committed to, so the export
// matches the completed count exactly even if prices moved since.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import * as XLSX from 'xlsx'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { fmtDuration } from '@/lib/format'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Format a timestamp in the owner's local (Swedish) time — counts are
// walked on-site, so UTC would just confuse. sv-SE gives "2026-06-03 16:44".
function fmtStamp(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('sv-SE', {
      timeZone: 'Europe/Stockholm',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: count, error: cErr } = await db
    .from('stock_counts')
    .select('id, business_id, count_date, location_id, notes, started_at, completed_at, created_by, total_value_at_count, total_lines, location:stock_locations(name)')
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'count not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, count.business_id)
  if (forbidden) return forbidden

  // Business name + counter name + lines (joined to product) in parallel.
  const [bizRes, userRes, linesRes] = await Promise.all([
    db.from('businesses').select('name').eq('id', count.business_id).maybeSingle(),
    count.created_by
      ? db.from('users').select('full_name, email').eq('id', count.created_by).maybeSingle()
      : Promise.resolve({ data: null } as any),
    db.from('stock_count_lines')
      .select('product_id, quantity, unit, unit_price_at_count, line_value_at_count, notes, product:products(name, category)')
      .eq('count_id', count.id),
  ])

  const bizName       = (bizRes.data as any)?.name ?? 'Business'
  const countedByName = (userRes.data as any)?.full_name || (userRes.data as any)?.email || '—'
  const locationName  = (count.location as any)?.name ?? 'Global count'

  let durationSeconds: number | null = null
  if (count.started_at && count.completed_at) {
    const ms = new Date(count.completed_at).getTime() - new Date(count.started_at).getTime()
    if (Number.isFinite(ms) && ms >= 0) durationSeconds = Math.round(ms / 1000)
  }

  const lines = (linesRes.data ?? [])
    .map((l: any) => ({
      name:       (l.product as any)?.name ?? '(deleted product)',
      category:   (l.product as any)?.category ?? '',
      quantity:   l.quantity != null ? Number(l.quantity) : null,
      unit:       l.unit ?? '',
      unit_price: l.unit_price_at_count != null ? Number(l.unit_price_at_count) : null,
      line_value: l.line_value_at_count != null ? Number(l.line_value_at_count) : null,
      notes:      l.notes ?? '',
    }))
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name))

  const totalValue = count.total_value_at_count != null
    ? Number(count.total_value_at_count)
    : lines.reduce((s, l) => s + (l.line_value ?? 0), 0)

  // ── Build the worksheet (array-of-arrays so metadata + table coexist) ──
  const aoa: any[][] = [
    ['Stock count'],
    ['Business',          bizName],
    ['Location',          locationName],
    ['Count date',        count.count_date],
    ['Counted by',        countedByName],
    ['Started',           fmtStamp(count.started_at)],
    ['Completed',         count.completed_at ? fmtStamp(count.completed_at) : 'In progress'],
    ['Time to count',     durationSeconds != null ? fmtDuration(durationSeconds) : '—'],
    ['Lines counted',     lines.length],
    ['Total value (SEK)', Math.round(totalValue * 100) / 100],
    [],
    ['Product', 'Category', 'Quantity', 'Unit', 'Unit price (SEK)', 'Line value (SEK)', 'Notes'],
    ...lines.map(l => [l.name, l.category, l.quantity, l.unit, l.unit_price, l.line_value, l.notes]),
    [],
    ['', '', '', '', '', Math.round(totalValue * 100) / 100, 'TOTAL'],
  ]

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = [
    { wch: 40 }, // Product
    { wch: 16 }, // Category
    { wch: 12 }, // Quantity
    { wch: 10 }, // Unit
    { wch: 16 }, // Unit price
    { wch: 16 }, // Line value
    { wch: 30 }, // Notes
  ]

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Stock count')
  const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  // Wrap in a Uint8Array — NextResponse's BodyInit type doesn't accept a
  // raw Node Buffer, though the bytes are identical.
  const body = new Uint8Array(buf)

  const slug = `${count.count_date}${locationName !== 'Global count' ? '-' + locationName.replace(/[^a-zA-Z0-9]+/g, '-') : ''}`
  const filename = `stock-count-${slug}.xlsx`

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

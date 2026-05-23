import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data } = await db
  .from('invoice_pdf_extractions')
  .select('fortnox_invoice_number, supplier_name_snapshot, rows_extracted, total_extracted, total_header, total_delta_pct, validation_warnings, error_message')
  .eq('business_id', bizId)
  .in('status', ['needs_review', 'failed', 'no_pdf'])
  .order('completed_at', { ascending: false, nullsFirst: false })
  .limit(20)

console.log(`Sample of needs_review / failed / no_pdf (${data?.length ?? 0}):`)
for (const r of data ?? []) {
  console.log(`  #${r.fortnox_invoice_number} ${(r.supplier_name_snapshot ?? '?').slice(0, 25).padEnd(27)} rows=${r.rows_extracted ?? '—'}  Δ=${r.total_delta_pct ?? '—'}%  warns=${JSON.stringify(r.validation_warnings ?? []).slice(0, 60)}  err=${(r.error_message ?? '').slice(0, 60)}`)
}

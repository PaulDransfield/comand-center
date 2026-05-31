// lib/fortnox/extract-voucher-ref.ts
//
// Extracts the SUPPLIERINVOICE voucher ref from a Fortnox supplier-
// invoice payload's Vouchers array. Used by the supplier-sync cron to
// populate `fortnox_supplier_invoices.voucher_series` + `.voucher_number`
// at write time.
//
// ── LOAD-BEARING FILTER ──────────────────────────────────────────────
//
// Each supplier invoice carries multiple voucher refs:
//   - one SUPPLIERINVOICE ref (the bookkeeping voucher; what we want)
//   - one SUPPLIERPAYMENT ref (the payment voucher; DIFFERENT voucher)
//   - sometimes others (credit notes, etc.)
//
// Filtering on ReferenceType='SUPPLIERINVOICE' is what makes the
// resulting (voucher_series, voucher_number) tuple point at the
// booking voucher — the one whose rows carry Account/Debit/Credit
// for the actual expense line items. If a caller grabbed the
// SUPPLIERPAYMENT ref by mistake, downstream joins would silently
// resolve to the wrong voucher (which has the bank/AP-credit rows,
// not expense rows) — a quiet correctness bug.
//
// ── SHARED WITH THE ONE-TIME BACKFILL SQL ─────────────────────────────
//
// sql/p20-paydown-ticket1-backfill-APPLY.sql mirrors this filter exactly
// in SQL (`v->>'ReferenceType' = 'SUPPLIERINVOICE'` + `LIMIT 1`). If you
// change the filter here, change it there too — drift produces
// inconsistent column values depending on whether a row was migrated
// or freshly written, which is the subtle bug the shared-logic
// discipline exists to prevent.

export interface ExtractedVoucherRef {
  voucher_series: string | null
  voucher_number: number | null
}

/**
 * Pulls (series, number) of the SUPPLIERINVOICE ref out of a Fortnox
 * supplier-invoice payload. Returns nulls if the input lacks a Vouchers
 * array or has no SUPPLIERINVOICE ref (e.g., invoice not yet booked,
 * or only carries a SUPPLIERPAYMENT ref).
 *
 * Takes the FIRST SUPPLIERINVOICE ref when multiple exist — in practice
 * each invoice has exactly one booking voucher; multiples would be a
 * rare credit-and-rebook scenario where the first is the original.
 */
export function extractSupplierInvoiceVoucher(inv: any): ExtractedVoucherRef {
  const vouchers = inv?.Vouchers
  if (!Array.isArray(vouchers)) {
    return { voucher_series: null, voucher_number: null }
  }
  const ref = vouchers.find((v: any) => v?.ReferenceType === 'SUPPLIERINVOICE')
  if (!ref) {
    return { voucher_series: null, voucher_number: null }
  }
  const series = typeof ref.Series === 'string' && ref.Series.length > 0 ? ref.Series : null
  const number = ref.Number != null && Number.isFinite(Number(ref.Number)) ? Number(ref.Number) : null
  return { voucher_series: series, voucher_number: number }
}

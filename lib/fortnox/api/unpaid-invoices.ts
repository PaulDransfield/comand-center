// lib/fortnox/api/unpaid-invoices.ts
//
// Phase 2 cash-flow projection inputs. Fetches unpaid supplier invoices
// (cash OUTFLOWS) and unpaid customer invoices (cash INFLOWS) with due
// dates in a given window from Fortnox.
//
// Endpoints:
//   /3/supplierinvoices?filter=unpaid    — bills the customer owes
//   /3/customerinvoices?filter=unpaid    — money owed to the customer
//
// Both endpoints return `Total` in customer's base currency (assumed SEK
// for Swedish restaurants). DueDate is a YYYY-MM-DD string.
//
// Soft-fails: any HTTP error returns an empty list rather than throwing —
// the cash-flow projection still works with the bank balance + salary
// estimate even when invoice data is unavailable.

import { fortnoxFetch } from './fetch'

const FORTNOX_API = 'https://api.fortnox.se/3'

export interface UnpaidInvoice {
  invoice_number:  string
  given_number:    string
  counterparty:    string       // SupplierName or CustomerName
  invoice_date:    string       // YYYY-MM-DD
  due_date:        string       // YYYY-MM-DD
  total:           number       // SEK
  currency:        string
  ocr:             string | null
  cancelled:       boolean
  /** Direction in cash-flow terms. supplier = outflow, customer = inflow. */
  direction:       'supplier' | 'customer'
}

export interface FetchUnpaidInvoicesResult {
  invoices: UnpaidInvoice[]
  total:    number   // sum of `total` (positive number — direction tells which way)
  count:    number
  error?:   string
}

async function fetchSide(
  accessToken: string,
  endpoint:    'supplierinvoices' | 'customerinvoices',
  todayIso:    string,
  windowEndIso: string,
  direction:   'supplier' | 'customer',
): Promise<FetchUnpaidInvoicesResult> {
  // Fortnox's `filter=unpaid` returns all unpaid + unpaidoverdue. We
  // filter the result by DueDate ≤ windowEnd in-app so we don't have to
  // page through years of dead invoices. /3/supplierinvoices supports
  // `?filter=unpaidoverdue` AND `?filter=unpaid` — we want both.
  const collected: UnpaidInvoice[] = []
  let error: string | undefined
  for (const filter of ['unpaid', 'unpaidoverdue'] as const) {
    for (let page = 1; page <= 5; page++) {
      const url = `${FORTNOX_API}/${endpoint}?filter=${filter}&limit=500&page=${page}`
      try {
        const res = await fortnoxFetch(url, accessToken)
        if (!res.ok) {
          error = `${endpoint}?filter=${filter} HTTP ${res.status}`
          break
        }
        const body: any = await res.json().catch(() => null)
        const list = endpoint === 'supplierinvoices'
          ? (body?.SupplierInvoices ?? [])
          : (body?.Invoices ?? [])
        for (const inv of list) {
          if (inv?.Cancelled) continue
          const dueDate = String(inv.DueDate ?? '').slice(0, 10)
          if (!dueDate) continue
          // Filter to the window we care about
          if (dueDate > windowEndIso) continue
          collected.push({
            invoice_number: String(inv.InvoiceNumber ?? inv.GivenNumber ?? ''),
            given_number:   String(inv.GivenNumber   ?? inv.InvoiceNumber ?? ''),
            counterparty:   String(inv.SupplierName ?? inv.CustomerName ?? '—'),
            invoice_date:   String(inv.InvoiceDate ?? '').slice(0, 10),
            due_date:       dueDate,
            total:          Number(inv.Total ?? 0),
            currency:       String(inv.Currency ?? 'SEK'),
            ocr:            inv.OCR ? String(inv.OCR) : null,
            cancelled:      !!inv.Cancelled,
            direction,
          })
        }
        const totalPages = Number(body?.MetaInformation?.['@TotalPages'] ?? body?.MetaInformation?.TotalPages ?? 1)
        if (page >= totalPages) break
      } catch (e: any) {
        error = `${endpoint}?filter=${filter} ${e?.message ?? e}`
        break
      }
    }
    if (error) break
  }

  // Dedupe by (direction, invoice_number) — `unpaid` and `unpaidoverdue`
  // overlap (overdue ⊂ unpaid) but Fortnox sometimes returns the same
  // record under both depending on version.
  const seen = new Set<string>()
  const deduped: UnpaidInvoice[] = []
  for (const inv of collected) {
    const k = `${inv.direction}|${inv.invoice_number}|${inv.given_number}`
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(inv)
  }

  // Sort by due_date ascending — cash-flow projection walks forward in time.
  deduped.sort((a, b) => a.due_date.localeCompare(b.due_date))

  const total = deduped.reduce((s, i) => s + i.total, 0)
  return { invoices: deduped, total: Math.round(total), count: deduped.length, error }
}

/**
 * Fetch unpaid supplier invoices (cash OUT) with due dates ≤ windowEndIso.
 */
export async function fetchUnpaidSupplierInvoices(
  accessToken: string,
  windowEndIso: string,
): Promise<FetchUnpaidInvoicesResult> {
  const todayIso = new Date().toISOString().slice(0, 10)
  return fetchSide(accessToken, 'supplierinvoices', todayIso, windowEndIso, 'supplier')
}

/**
 * Fetch unpaid customer invoices (cash IN) with due dates ≤ windowEndIso.
 */
export async function fetchUnpaidCustomerInvoices(
  accessToken: string,
  windowEndIso: string,
): Promise<FetchUnpaidInvoicesResult> {
  const todayIso = new Date().toISOString().slice(0, 10)
  return fetchSide(accessToken, 'customerinvoices', todayIso, windowEndIso, 'customer')
}

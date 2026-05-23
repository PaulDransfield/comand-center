// lib/revisor/momsrapport.ts
//
// R5 — Momsrapport (Skatteverket SKV 4700 VAT report).
//
// Computes a Swedish VAT report for a (business, year, month) by reading
// voucher rows from the M080 cache and classifying:
//   - Revenue accounts (3xxx) by VAT rate (25 / 12 / 6 / momsfri / utland)
//   - Output VAT accounts (2610-2630) by SKV box
//   - Input VAT accounts (2640-2649) into box 48
//
// Output mirrors the SKV 4700 form box numbers so the owner / revisor
// can compare line-by-line with what Skatteverket's e-tjänst shows.
//
// Period scope: the report is for THE REQUESTED MONTH ONLY (NOT YTD),
// which is how SKV 4700 is filed (monthly OR quarterly, never YTD-cumulative).
// The voucher cache stores YTD; we filter to the requested month here.
//
// Box derivation:
//   Box 05  = Σ revenue accounts (3xxx) that are Swedish-taxable
//   Box 10  = Σ output VAT 25 % accounts (2610, 2611)             — credit-net
//   Box 11  = Σ output VAT 12 % accounts (2612, 2620)             — credit-net
//   Box 12  = Σ output VAT  6 % accounts (2613, 2630)             — credit-net
//   Box 30  = Σ reverse-charge output VAT 25 % (2614, 2615)       — credit-net
//   Box 48  = Σ input VAT accounts (2640-2649, exc. 2648 vilande) — debit-net
//   Box 49  = (10 + 11 + 12 + 30 + 31 + 32) − 48  (net VAT)
//
// Sanity check: each VAT box implies a sales-by-rate floor.
//   Implied sales @ 25 % = Box 10 / 0.25
//   Implied sales @ 12 % = Box 11 / 0.12
//   Implied sales @  6 % = Box 12 / 0.06
//   Total implied        ≈ Box 05
// If the 3xxx sum differs from the implied total by > 1 %, we surface a
// reconciliation warning so the revisor knows to inspect.
//
// Voucher source: same cache as R3/R4 — instant after the first month
// load. No new schema needed; this is pure compute.

import { getCachedVouchersForRange }       from '@/lib/fortnox/voucher-cache'
import { basAccountDescription }           from './bas-chart'

// ── Account → SKV box maps ────────────────────────────────────────

// Output VAT accounts → box (10/11/12/30/31/32).
// Source: BAS 2024 standard. Restaurant customers occasionally have
// custom 26xx accounts but the standard suffix encodes the VAT rate.
const OUTPUT_VAT_ACCOUNT_TO_BOX: Record<number, 10 | 11 | 12 | 30 | 31 | 32> = {
  2610: 10,  // generic Sverige
  2611: 10,  // Sverige 25 %
  2612: 11,  // Sverige 12 %
  2613: 12,  // Sverige 6 %
  2614: 30,  // omvänd skattskyldighet 25 % (Sverige) → box 30
  2615: 30,  // import varor 25 %
  2617: 32,  // omvänd skattskyldighet 6 %
  2620: 11,  // alt 12 %
  2630: 12,  // alt 6 %
}

// Input VAT accounts → box 48. 2648 is "vilande" (pending unposted) and
// is excluded from the live report — it'll flush into a real 264x when
// the invoice is actually booked.
const INPUT_VAT_ACCOUNTS = new Set([2640, 2641, 2642, 2645, 2646, 2647, 2649])

// Revenue accounts → VAT rate. The Standard BAS pattern is xx01/xx11
// for 25 %, xx02/xx12 for 12 %, xx03/xx13 for 6 %, xx04/xx14 momsfri.
// Custom charts override this — we expose the classified accounts so
// the revisor sees which account went into which bucket.
type VatRate = '25' | '12' | '6' | '0' | 'eu' | 'utland' | 'other'

function classifyRevenueAccount(account: number): VatRate {
  const s = String(account)

  // BAS 32xx — EU sales
  if (account >= 3200 && account <= 3299) return 'eu'
  // BAS 31xx (varor utanför EU) + 33xx-34xx (tjänster utomlands)
  if (account >= 3100 && account <= 3199) return 'utland'
  if (account >= 3300 && account <= 3499) return 'utland'
  // BAS 30xx — Sverige domestic. Suffix encodes rate.
  if (account >= 3000 && account <= 3099) {
    const suffix = Number(s.slice(2)) // last 2 digits
    if (suffix >= 1 && suffix <=  9) return '25'   // 3001-3009
    if (suffix >= 10 && suffix <= 19) return '12'  // 3010-3019  / 3011 catered
    if (suffix >= 20 && suffix <= 29) return '6'   // 3020-3029
    if (suffix >= 30 && suffix <= 39) return '0'   // 3030-3039 momsfri
    if (suffix >= 40 && suffix <= 49) return '25'  // 3041 tjänster
    if (suffix >= 50 && suffix <= 59) return 'eu'
    return 'other'
  }
  // 35xx-39xx — sidointäkter, valutakurs, öresavrundning — treat as
  // 25 % unless customer puts them in a momsfri row.
  if (account >= 3500 && account <= 3999) return '25'
  return 'other'
}

// ── Public types ──────────────────────────────────────────────────

export interface MomsrapportLine {
  account:     number
  description: string
  amount:      number     // POSITIVE for sales/output, POSITIVE for input VAT
}

export interface MomsrapportBox {
  box:         number
  label:       string
  amount:      number     // SEK
  lines:       MomsrapportLine[]
}

export interface MomsrapportResult {
  business_id:        string
  period_year:        number
  period_month:       number
  period_label:       string                 // 'januari 2026'
  period_from:        string                 // YYYY-MM-DD
  period_to:          string                 // YYYY-MM-DD

  // Section A: taxable sales excluding VAT
  box_05:             MomsrapportBox         // domestic taxable sales (sum of 25/12/6%)
  box_06:             MomsrapportBox         // uttag (rare for restaurants)
  box_07:             MomsrapportBox         // VMB
  box_08:             MomsrapportBox         // hyresinkomster

  // Section B: output VAT on sales (10-12)
  box_10:             MomsrapportBox         // 25 %
  box_11:             MomsrapportBox         // 12 %
  box_12:             MomsrapportBox         // 6 %

  // Section D: output VAT on reverse-charge purchases (30-32)
  box_30:             MomsrapportBox         // 25 %
  box_31:             MomsrapportBox         // 12 %
  box_32:             MomsrapportBox         // 6 %

  // Section E: input VAT (48)
  box_48:             MomsrapportBox

  // Section F: EU / utland sales
  box_35:             MomsrapportBox         // varor till EU
  box_36:             MomsrapportBox         // varor utanför EU
  box_38:             MomsrapportBox         // tjänster till EU
  box_39:             MomsrapportBox         // tjänster utanför Sverige
  box_40:             MomsrapportBox         // övrig försäljning

  // Section G: net VAT
  total_output_vat:   number                 // 10 + 11 + 12 + 30 + 31 + 32
  total_input_vat:    number                 // 48
  box_49:             number                 // net VAT to pay/recover

  // Reconciliation diagnostics
  implied_sales_25:   number                 // Box 10 / 0.25
  implied_sales_12:   number                 // Box 11 / 0.12
  implied_sales_06:   number                 // Box 12 / 0.06
  implied_sales_total: number
  reconciliation:     {
    declared_sales:   number                 // Box 05
    implied_sales:    number                 // sum of implied
    diff_kr:          number                 // declared - implied
    diff_pct:         number
    in_tolerance:     boolean                // |diff_pct| < 1 %
  }

  voucher_count:      number
}

// ── Main entrypoint ───────────────────────────────────────────────

const MONTH_NAMES_SV = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

export async function computeMomsrapport(
  db:         any,
  orgId:      string,
  businessId: string,
  year:       number,
  month:      number,
): Promise<MomsrapportResult> {
  // 1. Period bounds — single month, NOT YTD.
  const fromDate = `${year}-${String(month).padStart(2, '0')}-01`
  const toDate   = (() => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  })()

  // 2. We fetch the WHOLE YTD range from the cache (which is how the
  //    cache is keyed) and filter in-memory to the requested month.
  //    This stays cheap because the cache is sub-second after the
  //    voucher list has been loaded once.
  const fyStart = `${year}-01-01`
  const fetchResult = await getCachedVouchersForRange({
    db,
    orgId,
    businessId,
    fromDate: fyStart,
    toDate,
  })
  const monthVouchers = fetchResult.vouchers.filter(v => {
    const d = (v as any).TransactionDate ?? (v as any).Date ?? ''
    return d >= fromDate && d <= toDate
  })

  // 3. Bucket voucher-row net amounts.
  //    Convention reminder: voucher rows are debit-positive.
  //      Revenue accounts (3xxx)        → CREDIT-net positive = sales amount
  //      Output VAT accounts (26xx top) → CREDIT-net positive = VAT collected
  //      Input VAT accounts  (264x)     → DEBIT-net positive  = VAT paid
  //
  // We aggregate per account, then assign each account to its target box.

  type AccBucket = { debit: number; credit: number; description: string }
  const perAccount = new Map<number, AccBucket>()

  for (const v of monthVouchers) {
    for (const r of (v.VoucherRows ?? [])) {
      if ((r as any).Removed) continue
      const acc = Number(r.Account)
      if (!Number.isFinite(acc)) continue
      let b = perAccount.get(acc)
      if (!b) {
        b = { debit: 0, credit: 0, description: r.AccountDescription ?? basAccountDescription(acc) }
        perAccount.set(acc, b)
      }
      b.debit  += Number(r.Debit)  || 0
      b.credit += Number(r.Credit) || 0
    }
  }

  // 4. Initialise empty boxes.
  const mkBox = (box: number, label: string): MomsrapportBox => ({
    box, label, amount: 0, lines: [],
  })

  const out = {
    box_05: mkBox( 5, 'Momspliktig försäljning som inte ingår i ruta 06, 07 eller 08'),
    box_06: mkBox( 6, 'Momspliktig uttag'),
    box_07: mkBox( 7, 'Beskattningsunderlag vid vinstmarginalbeskattning'),
    box_08: mkBox( 8, 'Hyresinkomster vid frivillig skattskyldighet'),
    box_10: mkBox(10, 'Utgående moms 25 %'),
    box_11: mkBox(11, 'Utgående moms 12 %'),
    box_12: mkBox(12, 'Utgående moms 6 %'),
    box_30: mkBox(30, 'Utgående moms omvänd skattskyldighet 25 %'),
    box_31: mkBox(31, 'Utgående moms omvänd skattskyldighet 12 %'),
    box_32: mkBox(32, 'Utgående moms omvänd skattskyldighet 6 %'),
    box_48: mkBox(48, 'Ingående moms att dra av'),
    box_35: mkBox(35, 'Försäljning av varor till annat EU-land'),
    box_36: mkBox(36, 'Försäljning av varor utanför EU'),
    box_38: mkBox(38, 'Försäljning av tjänster till näringsidkare i annat EU-land'),
    box_39: mkBox(39, 'Övrig försäljning av tjänster omsatta utomlands'),
    box_40: mkBox(40, 'Övrig försäljning m.m.'),
  }

  // 5. Walk every account, assign to box.
  const pushLine = (b: MomsrapportBox, acc: number, amount: number, desc: string) => {
    if (Math.abs(amount) < 0.5) return
    b.lines.push({ account: acc, description: desc, amount })
    b.amount += amount
  }

  for (const [acc, entry] of perAccount.entries()) {
    const creditNet = entry.credit - entry.debit
    const debitNet  = entry.debit  - entry.credit

    // ── Output VAT accounts ────────────────────────────────────
    const outBox = OUTPUT_VAT_ACCOUNT_TO_BOX[acc]
    if (outBox !== undefined && creditNet !== 0) {
      const target =
        outBox === 10 ? out.box_10 :
        outBox === 11 ? out.box_11 :
        outBox === 12 ? out.box_12 :
        outBox === 30 ? out.box_30 :
        outBox === 31 ? out.box_31 :
                        out.box_32
      pushLine(target, acc, creditNet, entry.description)
      continue
    }

    // ── Input VAT accounts ─────────────────────────────────────
    if (INPUT_VAT_ACCOUNTS.has(acc) && debitNet !== 0) {
      pushLine(out.box_48, acc, debitNet, entry.description)
      continue
    }

    // ── Revenue accounts → box 05 / 35 / 36 / 38 / 39 / 40 ─────
    if (acc >= 3000 && acc <= 3999) {
      const rate = classifyRevenueAccount(acc)
      if (creditNet <= 0.5) continue           // ignore tiny / refund-only

      // Domestic taxable sales (25/12/6) → box 05
      if (rate === '25' || rate === '12' || rate === '6') {
        pushLine(out.box_05, acc, creditNet, entry.description)
        continue
      }
      // EU sales — naive: assume 32xx is varor (box 35), 33xx tjänster (box 38)
      if (rate === 'eu') {
        if (acc >= 3200 && acc <= 3299) pushLine(out.box_35, acc, creditNet, entry.description)
        else                            pushLine(out.box_38, acc, creditNet, entry.description)
        continue
      }
      if (rate === 'utland') {
        // 31xx = varor utanför EU = box 36; 33-34xx = tjänster utomlands = box 39
        if (acc >= 3100 && acc <= 3199) pushLine(out.box_36, acc, creditNet, entry.description)
        else                            pushLine(out.box_39, acc, creditNet, entry.description)
        continue
      }
      if (rate === '0') {
        // momsfri — outside the VAT system. Goes into box 40.
        pushLine(out.box_40, acc, creditNet, entry.description)
        continue
      }
      // 35xx-39xx side revenue — typically still 25 % taxable (annons,
      // faktureringsavgift, etc.) → box 05 to keep VAT base honest.
      if (rate === 'other') {
        pushLine(out.box_05, acc, creditNet, entry.description)
        continue
      }
    }
    // anything else (4xxx-8xxx) is irrelevant for momsrapport.
  }

  // Sort lines within each box for stable display.
  for (const key of Object.keys(out) as (keyof typeof out)[]) {
    out[key].lines.sort((a, b) => a.account - b.account)
  }

  // 6. Aggregates + reconciliation
  const total_output_vat =
    out.box_10.amount + out.box_11.amount + out.box_12.amount +
    out.box_30.amount + out.box_31.amount + out.box_32.amount
  const total_input_vat = out.box_48.amount
  const box_49          = total_output_vat - total_input_vat

  const implied_sales_25 = out.box_10.amount / 0.25
  const implied_sales_12 = out.box_11.amount / 0.12
  const implied_sales_06 = out.box_12.amount / 0.06
  const implied_sales_total = implied_sales_25 + implied_sales_12 + implied_sales_06

  const declared_sales = out.box_05.amount
  const diff_kr  = declared_sales - implied_sales_total
  const denom    = Math.max(Math.abs(declared_sales), Math.abs(implied_sales_total), 1)
  const diff_pct = (diff_kr / denom) * 100

  return {
    business_id:         businessId,
    period_year:         year,
    period_month:        month,
    period_label:        `${MONTH_NAMES_SV[month - 1]} ${year}`,
    period_from:         fromDate,
    period_to:           toDate,
    box_05:              out.box_05,
    box_06:              out.box_06,
    box_07:              out.box_07,
    box_08:              out.box_08,
    box_10:              out.box_10,
    box_11:              out.box_11,
    box_12:              out.box_12,
    box_30:              out.box_30,
    box_31:              out.box_31,
    box_32:              out.box_32,
    box_48:              out.box_48,
    box_35:              out.box_35,
    box_36:              out.box_36,
    box_38:              out.box_38,
    box_39:              out.box_39,
    box_40:              out.box_40,
    total_output_vat,
    total_input_vat,
    box_49,
    implied_sales_25,
    implied_sales_12,
    implied_sales_06,
    implied_sales_total,
    reconciliation: {
      declared_sales,
      implied_sales:  implied_sales_total,
      diff_kr,
      diff_pct,
      in_tolerance:   Math.abs(diff_pct) < 1,
    },
    voucher_count: monthVouchers.length,
  }
}

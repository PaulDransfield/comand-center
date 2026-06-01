// lib/inventory/recipe-price.ts
//
// Single source of price truth for recipes (post-M109).
//
// The rule, stated bluntly: `selling_price_ex_vat` is the canonical stored
// value. `menu_price` exists only as a derived inc-VAT display value
// (`= ex_vat × (1 + vat_rate/100)`). The two MUST NEVER be edited
// independently into inconsistency — every write goes through this
// resolver, which collapses any of three input shapes into a coherent
// (ex_vat, vat_rate, channel, menu_price) tuple.
//
// VAT independence rule (from `lib/sweden/vat.ts`): vat_rate and channel
// are independent owner-set fields. A dine-in pinsa is 12%, a takeaway
// pinsa is 6%, an alcoholic drink is 25% regardless of channel — channel
// does NOT determine rate. This resolver never infers one from the other.

export interface ResolvedPriceFields {
  selling_price_ex_vat: number | null
  vat_rate:             number | null
  channel:              string | null
  menu_price:           number | null
  error?:               string
}

// Owner can pass any of three input shapes:
//   1. selling_price_ex_vat (+ vat_rate)  — canonical input
//   2. menu_price_inc_vat (+ vat_rate)    — converter: ex_vat derived from inc-VAT / (1 + r/100)
//   3. menu_price (legacy)                — back-compat: stored as-is, ex_vat left null
// vat_rate and channel are independent owner-set fields. An explicit
// vat_rate is required when an inc-VAT price is supplied (we never infer
// from channel).
export function resolveRecipePriceFields(body: any): ResolvedPriceFields {
  const vatRateRaw = body?.vat_rate
  const channelRaw = body?.channel
  const exVatRaw   = body?.selling_price_ex_vat
  const incVatRaw  = body?.menu_price_inc_vat   // converter helper input
  const legacyMP   = body?.menu_price           // legacy passthrough

  // ── Channel (optional, independent of rate) ──
  let channel: string | null = null
  if (channelRaw !== undefined && channelRaw !== null) {
    const ch = String(channelRaw).trim().toLowerCase()
    if (ch && ch !== 'dine_in' && ch !== 'takeaway') {
      return { selling_price_ex_vat: null, vat_rate: null, channel: null, menu_price: null,
               error: `channel must be 'dine_in' or 'takeaway' (got "${ch}")` }
    }
    channel = ch || null
  }

  // ── Vat_rate (optional, independent of channel) ──
  let vatRate: number | null = null
  if (vatRateRaw !== undefined && vatRateRaw !== null) {
    const r = Number(vatRateRaw)
    if (!Number.isFinite(r) || r < 0 || r > 30) {
      return { selling_price_ex_vat: null, vat_rate: null, channel, menu_price: null,
               error: 'vat_rate must be between 0 and 30' }
    }
    vatRate = r
  }

  // ── Price resolution priority ──
  // 1. Explicit ex-VAT wins (canonical)
  if (exVatRaw !== undefined && exVatRaw !== null) {
    const ex = Number(exVatRaw)
    if (!Number.isFinite(ex) || ex < 0) {
      return { selling_price_ex_vat: null, vat_rate: vatRate, channel, menu_price: null,
               error: 'selling_price_ex_vat must be a non-negative number' }
    }
    const derivedMP = vatRate != null
      ? Math.round(ex * (1 + vatRate / 100) * 100) / 100
      : null
    return { selling_price_ex_vat: ex, vat_rate: vatRate, channel, menu_price: derivedMP }
  }

  // 2. Inc-VAT converter — derive ex_vat (requires vat_rate)
  if (incVatRaw !== undefined && incVatRaw !== null) {
    const inc = Number(incVatRaw)
    if (!Number.isFinite(inc) || inc < 0) {
      return { selling_price_ex_vat: null, vat_rate: vatRate, channel, menu_price: null,
               error: 'menu_price_inc_vat must be a non-negative number' }
    }
    if (vatRate == null) {
      return { selling_price_ex_vat: null, vat_rate: null, channel, menu_price: null,
               error: 'vat_rate is required when entering menu_price_inc_vat (channel does not determine rate)' }
    }
    const ex = Math.round((inc / (1 + vatRate / 100)) * 100) / 100
    return { selling_price_ex_vat: ex, vat_rate: vatRate, channel, menu_price: inc }
  }

  // 3. Legacy menu_price — back-compat; stored as-is, ex_vat left null.
  //    Callers that only know about menu_price (pre-M109) keep working;
  //    the recipe just won't have a derived margin until owner sets ex_vat.
  if (legacyMP !== undefined && legacyMP !== null) {
    const mp = Number(legacyMP)
    if (!Number.isFinite(mp) || mp < 0) {
      return { selling_price_ex_vat: null, vat_rate: vatRate, channel, menu_price: null,
               error: 'menu_price must be a non-negative number' }
    }
    return { selling_price_ex_vat: null, vat_rate: vatRate, channel, menu_price: mp }
  }

  // 4. No price at all — fine.
  return { selling_price_ex_vat: null, vat_rate: vatRate, channel, menu_price: null }
}

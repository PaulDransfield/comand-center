// lib/inventory/description-rules.ts
//
// Description-level not_inventory veto. Catches structural noise that
// SHOULD never be a product regardless of what BAS account it's booked
// to: rebates, deposits (pant), packaging units (pallets/crates/kolli),
// and pure logistics fees.
//
// Why this exists as a separate signal from BAS account routing:
// accountants book these to a variety of accounts — some go on 4xxx
// food (e.g. Snabbgross posts PANT ALUMINIUMBURK to 4011 alcohol, since
// the deposit relates to alcoholic cans). Trusting BAS alone wrongly
// elevates them to the review queue. The description rule catches the
// kind from the descriptor.
//
// ── ANCHORING DISCIPLINE (learned the hard way) ──────────────────────
//
// The hard lesson from the original ^pant fix: mid-string tokens on
// real product descriptions MUST NOT be caught. The "Varav pant per
// enhet:" annotation on Coca-Cola lines is the cautionary example —
// a real product that incidentally contains the word "pant".
//
// Therefore: new arms are ANCHORED to ^ (start of description) + word
// boundary (\b in JS, \M in PG ARE). Each new arm passes a
// both-directions check in dry-run before shipping:
//   A: catches the noise it's meant to
//   B: does NOT catch any real product whose description merely
//      contains the token
//
// The existing arms (avtalsrabatt, pantersättning, öresavrundning,
// faktureringsavg, inkassoarvode, påminnelseavg) are UNANCHORED — they
// match anywhere in the description. This is correct because:
//   - These compound words don't appear inside real product names
//   - Avtalsrabatt specifically appears as a SUFFIX on product-named
//     lines (e.g. "DE KUYPER RASPB PUCKER 15% 1X0,70 BOT Avtalsrabatt")
//     where the line IS a rebate credit FOR that product — correctly
//     classified as not_inventory
//
// If you add a new arm with a generic token (frakt, distribution, etc.),
// it MUST be ^-anchored. Don't add unanchored arms unless the token is
// as specific as "avtalsrabatt" — and even then, run the both-directions
// check first.

// Postgres ARE equivalent of this pattern is kept in sql/p20-fix2-deposit-
// logistics-DRY.sql for the one-time backfill. They MUST stay in sync. If
// you update one, update the other (and run the both-directions dry-run
// in scripts/diag-gate0-precedence-deposit-dryrun.mjs to confirm).
const DEPOSIT_LOGISTICS_REBATE_PATTERN = new RegExp(
  '(' +
    // ── Unanchored compound-word arms (P2.0 originals + 2026-06-01 lokalhyra) ──
    // These compound words don't appear inside real product names; safe
    // as substring matches. Avtalsrabatt specifically can be a SUFFIX on
    // product-named credit lines.
    //
    // lokalhyra / "hyra lokal" / "lokal hyra" caught here because real
    // rent invoices land as "<room name> – Hyra lokal" (e.g. "Förråd –
    // Hyra lokal", "Restaurang/café – Hyra lokal" — Behrn landlord
    // invoices at Chicce). An ^-anchored arm would miss all of these.
    // Both-directions dry-run 2026-06-01 confirmed 65/65 rent lines
    // caught, 0 false positives on Loka-brand drink products at Vero
    // ("Lokal Hallon/Rabarber" — contains "lokal" alone but not the
    // compound `lokal\\s+hyra` or `hyra\\s+lokal`).
    'avtalsrabatt' +
    '|^rabatt' +
    '|^pant\\b' +
    '|pantersättning' +
    '|öresavrundning' +
    '|faktureringsavg' +
    '|inkassoarvode' +
    '|påminnelseavg' +
    '|lokalhyra' +
    '|hyra\\s+lokal' +
    '|lokal\\s+hyra' +

    // ── Anchored deposit/return arms ──
    '|^pantgr[öo]n\\b' +              // PANTGRÖN Retur SRS Back
    '|^pba\\s+retur' +                // PBA RETURLÅDA HEL SRS
    '|^srs\\s+(?:retur|back)' +       // SRS RETURBACK, SRS backar, SRS back
    '|^retur\\s+srs' +                // Retur SRS Back

    // ── Anchored pallet / packaging arms ──
    '|^eur[-\\s]?pall\\b' +           // EUR-PALL, EUR PALL, EURPALL, EUR-pall
    '|^plastpall\\b' +                // PLASTPALL SRS 1/2
    '|^pallet\\b' +                   // PALLET HALF WOODEN EUR FI
    '|^halvpall\\b' +                 // Trädgårdshallen halvpall
    '|^eng[åa]ngspall\\b' +           // Trädgårdshallen engångspall
    '|^kolli\\b' +                    // Trädgårdshallen kolli (packaging units)

    // ── Anchored logistics/fee arms ──
    '|^distribution\\s+' +            // Distribution Chicce/All Event/Frimis
    '|^leveransavgift\\b' +           // Leveransavgift, LEVERANSAVGIFT 400KR
    '|^plockavgift\\b' +              // Plockavgift mellan/stor, Plockavgift liten
    '|^frakt\\b' +                    // Frakt, FRAKT E-HANDEL
    '|^milj[öo]rabatt\\b' +           // Miljörabatt/Lev.avgift

  ')',
  'i'  // case-insensitive
)

/**
 * Returns 'not_inventory' if the description matches a deposit, return,
 * pallet, packaging, logistics, or rebate pattern. Returns null otherwise.
 *
 * Used as one of three signals in matcher.ts Gate 0. The matcher treats
 * any 'not_inventory' return as a veto over the positive BAS / supplier
 * routing — a pallet booked to 4011 alcohol is still a pallet.
 */
export function descriptionRule(rawDescription: string | null | undefined): 'not_inventory' | null {
  if (!rawDescription) return null
  return DEPOSIT_LOGISTICS_REBATE_PATTERN.test(rawDescription) ? 'not_inventory' : null
}

// Exported for the diag scripts that need to display which arm fired.
// Not used by the matcher itself.
export const DEPOSIT_LOGISTICS_REBATE_PATTERN_RE = DEPOSIT_LOGISTICS_REBATE_PATTERN

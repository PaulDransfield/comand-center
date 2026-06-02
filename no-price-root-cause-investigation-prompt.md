# Claude Code — The no_price Epidemic: Root-Cause Investigation (READ-ONLY)

## Purpose

The Needs-attention filter surfaced something far bigger than a tidy-up backlog: **Chicce 954 and Vero 930 items flag `no_price`** — most of each catalogue. The diagnosis so far is the PDF extractor "often captures one but not both" of `price_per_unit` and a usable `total_excl_vat`/`quantity` pair, so the cost layer can't resolve a per-unit price.

That number is too large to hand-fix and its size implies a **systematic, fixable extraction/derivation problem**, not a data-entry gap. Crucially: a per-unit price is derivable from `total ÷ quantity`, and a total from `price_per_unit × quantity` — so if *either* pair is present, price *should* be computable. The whole question is:

**Of the ~950 no-price items, for how many is a usable price DERIVABLE from fields already captured (but the cost layer isn't deriving it) — vs how many genuinely lack any usable price data?**

That split decides everything: the first case is a one-shot derivation/extraction fix that recovers most of the catalogue's pricing; the second is a deeper extraction problem. Find the split. **Read-only — diagnose, don't fix.**

## HARD RULES
- **READ-ONLY.** `SELECT` / code-read only. No writes, no re-extraction, no migrations, no cost-layer changes.
- Print every query / file inspected.
- Scope: the no-price `supplier_invoice_lines` / `products` populations at Chicce + Vero.
- Deliverable: `docs/investigation/no-price-root-cause.md` + three-line chat summary. **No fix** — the fix is scoped separately once we know the split.

## Step 1 — Anatomy of a no-price item: what fields ARE captured

For the no-price population, look at the underlying `supplier_invoice_lines` that should give the price:
1. For a no-price product, which price-relevant fields are populated on its most-recent invoice line(s)? Tabulate the combinations across the population:
   - has `price_per_unit`, has `total_excl_vat`, has `quantity` — which of the 3 are present?
2. Bucket the population by field-presence pattern:
   - **(D1) total + quantity present, price_per_unit missing** → price = total/qty is DERIVABLE. Why isn't it being derived?
   - **(D2) price_per_unit present, but not surfacing** → price exists in the data but the cost layer isn't reading it. A plumbing gap.
   - **(D3) price_per_unit + total + quantity all present but inconsistent** (total ≠ ppu × qty) → the per-line misread class (see Step 3).
   - **(N) none of the usable pairs present** → genuinely no price data; not recoverable from what we have.
3. Report the **counts in each bucket** — this is the headline split (D1+D2+D3 = recoverable via fix; N = genuinely missing).

## Step 2 — Why isn't the cost layer deriving it? (code read)

Read the price-resolution path (`getProductLatestPrices` / `recipe-cost.ts` / wherever `latest_price` / `cost_per_base_unit` is computed):
1. When a line has `total_excl_vat` + `quantity` but no `price_per_unit`, does the cost layer compute `total/quantity`, or does it only read `price_per_unit` and give up if null? (If the latter — that's the D1 fix: derive the missing field.)
2. Is there a unit/pack-size conversion step that fails (price present but `cost_per_base_unit` can't resolve because pack_size/base_unit missing)? Distinguish "no price" from "price present but no usable per-base-unit conversion".
3. Identify the exact point where a derivable price is being dropped — that's the fix location.

## Step 3 — Cross-check the Marini/Rima per-line misread (is it broader than one supplier?)

We previously found Marini/Rima invoices where the extractor wrote `total = price_per_unit` instead of `total = ppu × qty` (per-line column misread), and the reconciliation guard rejects those as `total_mismatch`. A catalogue-wide no-price population is exactly what that bug looks like at scale if it's not unique to Marini/Rima.
1. Across the no-price population, how many lines have `total_excl_vat ≈ price_per_unit` (i.e. total looks like it's missing the × quantity) — the misread signature?
2. Which suppliers does that pattern span? (Marini/Rima only, or broader — the answer changes the fix scope a lot.)
3. How many no-price items trace to invoices currently failing the `over_extraction`/`total_mismatch` guards (i.e. silently rejected, looking like failures but actually the per-line bug)?

## Step 4 — The verdict + fix sizing (scope, don't build)

- **The split:** of ~950 per business, how many are recoverable-via-fix (D1/D2/D3) vs genuinely-missing (N).
- **The fix shape for the recoverable majority:** is it a cost-layer derivation fix (compute price from total/qty when ppu is null — small, recovers D1/D2 instantly with no re-extraction), an extraction fix (re-extract to recover per-line values — bigger), or the per-line misread fix extended beyond Marini/Rima (D3)?
- **Recovery magnitude:** if the derivation fix lands, roughly how many of the ~950 per business resolve to a real price automatically?
- Note whether this is the same root cause as the per-line/multi-page extraction issues (consolidating several problems) or distinct.

## Deliverable

`docs/investigation/no-price-root-cause.md` + three-line chat summary:
1. The split — of ~950 no-price items per business, how many have a price DERIVABLE from already-captured fields (recoverable) vs genuinely no usable price data;
2. Where the price is being dropped — is the cost layer failing to derive total/qty when price_per_unit is null (the likely one-shot fix), and/or is the Marini/Rima per-line misread broader than one supplier;
3. Fix shape + magnitude — is the recoverable majority a small cost-layer derivation fix (no re-extraction) that resolves most of the catalogue's pricing, or a deeper extraction problem — and does it consolidate with the per-line/multi-page issues.

Every query/file listed. No writes, no fix.

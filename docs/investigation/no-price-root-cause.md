# no_price root-cause investigation (READ-ONLY)

> 2026-06-02 | Per `no-price-root-cause-investigation-prompt.md`. NO FIX SHIPPED — investigation only. The previous chat summary's "954 / 930 no_price" figures were a diagnostic artifact, not a real catalogue-wide pricing gap.

## Scripts / files inspected

| Purpose | File |
|---|---|
| Items API (where the signals are computed) | `app/api/inventory/items/route.ts` |
| Cost-engine price reader | `lib/inventory/recipe-cost.ts` (`getProductLatestPricesLeaf` + `getProductLatestPrices`) |
| Original needs-attention diag | `scripts/diag/diag-needs-attention.mjs` |
| Aliases-only sanity check | `scripts/diag/diag-aliases-check.mjs` |
| Anatomy / bucket diag | `scripts/diag/diag-no-price-anatomy.mjs` (this investigation) |
| API-path replay diag | `scripts/diag/diag-api-path-replay.mjs` (this investigation) |

---

## 1. The headline: the epidemic is largely artefact

The "954 Chicce / 930 Vero no_price" figures I reported in the previous chat summary were produced by a diagnostic that hit Supabase's 16 KB HTTP header limit on a `.in('id', [500 UUIDs])` call. The error is `HeadersOverflowError` (`UND_ERR_HEADERS_OVERFLOW`) at the undici layer; the supabase-js client surfaces it as `{ error: <object> }` if you check, but **the deployed API code I just shipped does NOT check the error** — the result is `{ data: null }`, which gets coalesced to `?? []` and produces silently-empty alias maps.

When the alias→product map is silently empty:
- Every product gets `aliasCountByProduct.get(p.id) ?? 0 = 0` → `no_article` flags every product
- Most `supplier_invoice_lines` rows can't resolve their `product_alias_id → product_id` → `latestLineByProduct.get(pid)` returns undefined for most products → they fall into the `latest == null` branch → if they're not recipe-promoted, `no_price` fires

When the same diag is rerun with batch=100 (URL under the header limit), the true counts emerge.

**The deployed `/api/inventory/items` route has the same bug** — same 500-element batches in the alias preflight (lines ~157-186 in `route.ts`) AND in the existing alias-id→product join (lines ~177-186, the pre-existing code I didn't touch). So owners hitting `/inventory/items` in the live preview will see the inflated 1000 / 977 needs-attention counts.

---

## 2. True anatomy of the no-price population

From `scripts/diag/diag-no-price-anatomy.mjs` (batched at 200 — under URL cap):

### Chicce: 99 no-price products total
- **98 have NO matched line at all** — recipe-promoted (M089 products) or manually-created via the recipe drawer / "+ Add article". These get their price from the linked recipe via `getProductLatestPrices` → `recipe-sourced` branch. The API's `no_price` signal already excludes `source_recipe_id` products → they won't actually flag once the alias-batch bug is fixed.
- **1 product has a matched line but no usable price**: Carlsberg item, latest line has only `total_excl_vat` populated (no `quantity`, no `price_per_unit`)

### Vero: 160 no-price products total
- **157 have NO matched line at all** — same recipe-promoted / manual category
- **3 products have a matched line but no usable price**: Carlsberg, Martin Servera, Rosalis. Latest lines have `total` only or partial fields

### Bucket breakdown (Chicce / Vero, among products WITH a matched line)
| Bucket | Chicce | Vero | Meaning |
|---|---|---|---|
| **D1** (total + qty present, no ppu) | 0 | 0 | derivable from total/qty (would be a fix opportunity) |
| **D2** (ppu present but not surfacing) | 0 | 0 | plumbing gap |
| **D3** (all 3 present, total ≠ ppu × qty by >5 %) | 0 | 0 | per-line misread (Marini/Rima class) |
| **N**  (none usable) | 1 | 3 | genuinely missing |

Cross-check: **"`total ≈ price_per_unit`" signature** (the Marini/Rima per-line misread, where `total` was written where `total = ppu × qty` should have been) is **0** across the no-price latest-line populations of both businesses. The Marini/Rima misread is NOT broader than the previously-identified single-supplier issue.

---

## 3. Where price gets derived in the cost layer (no bugs found here)

`lib/inventory/recipe-cost.ts::getProductLatestPricesLeaf` (lines 526-571):

```ts
const qty   = Number(l.quantity ?? 0)
const total = Number(l.total_excl_vat ?? 0)
let nativePrice: number
if (Number.isFinite(qty) && qty > 0 && Number.isFinite(total) && total !== 0) {
  nativePrice = total / qty                 // ← derives from total/qty FIRST
} else if (l.price_per_unit != null) {
  nativePrice = Number(l.price_per_unit)    // ← falls back to ppu
} else {
  continue                                  // ← drops the line
}
```

The cost engine **already does the derivation correctly**. `total/qty` wins over `price_per_unit` when both are available (per the M094 Mutti fix — extractor's `price_per_unit` is unreliable; `total_excl_vat` is validated against the invoice header during extraction). This is the right policy.

**There is no "cost-layer fails to derive price" bug**. The needs-attention API's `hasUsablePrice` check mirrors this logic (`total_excl_vat != null && quantity != null && Number(quantity) > 0 || price_per_unit != null`). For the 4 genuinely-no-price products, the underlying lines truly have NEITHER usable pair — no derivation can rescue them.

---

## 4. The fix shape — small, single-file

### The ONE real fix
**Reduce the alias `.in('id', ...)` batch sizes in `app/api/inventory/items/route.ts` from 500 to 100.**

Two locations:
- Line ~157-185 (the preflight I added): the `productIds.slice(i, i + 500)` loop fetching active aliases per product
- Line ~177-187 (pre-existing): the `aliasIds.slice(i, i + 500)` loop building `aliasToProduct` from `supplier_invoice_lines.product_alias_id`

Both should be 100. The supabase-js error from `HeadersOverflowError` is silent (the client returns `{ data: null }` without throwing), so the API silently produced wrong numbers. After the fix:
- `no_article` drops from ~1000 → ~98 (Chicce) / ~155 (Vero) — the real products without aliases
- `no_price` drops from ~771 / ~930 → 0 / 0 (after excluding recipe-promoted products, which my logic already does) plus the 1 Chicce + 3 Vero genuinely-missing-price products

Magnitude of recovery: **all of Chicce's ~770 and all of Vero's ~930 falsely-flagged no_price products resolve to a real price the moment the batch size is right**. The catalogue is healthy; the alarm was sounded by the diagnostic itself.

### Defensive add-on (recommended but separate)
After fixing the batch size, also check the `error` property of every supabase-js call in this route — silent `{ data: null }` from a network-level failure is the failure mode that hid this for an hour. Pattern:
```ts
const { data, error } = await db.from('X').select(...)
if (error) throw new Error(`X query failed: ${error.message}`)
```

This is a Session-19-style defensive-fail-fast change, not a no_price fix per se.

### NOT a fix
- No re-extraction needed.
- No cost-layer change needed.
- No Marini/Rima misread broadening (verified 0 across the no-price latest-line populations).
- No new schema, no migrations.

---

## 5. Consolidation with prior extraction issues

The previous extractor problems documented in `marini-rima-reextract-results.md` and the multi-page passthrough work were genuine per-line / per-invoice issues with real fixes (the matcher's `total_excl_vat / quantity` rule, the cascade-to-Sonnet path). **This is a different problem** — a UI-layer signal that was wrong because of an API URL-cap bug. The two don't consolidate.

The genuinely-no-price 4-product population at the bottom of the funnel is small enough to inspect by hand: 1 Carlsberg line at Chicce + 1 Carlsberg + 1 Martin Servera + 1 Rosalis at Vero. Each appears to be a special-case invoice (rebate-like line, end-of-month adjustment, or a partial extraction). Not a systematic class.

---

## Summary

1. The 954/930 figures were **diagnostic artifact + identical API bug**. Both share the same root cause: 500-element `.in()` calls exceed Supabase's 16 KB HTTP header limit, the error is silent in supabase-js, and the result is `{ data: null }`. With batch ≤ 100 the queries succeed and the true numbers emerge.
2. **There is no no_price epidemic.** Of 1248 Chicce products, 1 genuinely lacks a usable price (a single Carlsberg line). Of 977 Vero products, 3 do (Carlsberg + Martin Servera + Rosalis). The 98 Chicce / 157 Vero products without a matched line are recipe-promoted (M089) and get prices from their linked recipe — the API's `no_price` signal already excludes them.
3. **The fix is a one-line batch-size reduction** in `app/api/inventory/items/route.ts` (500 → 100) at two locations. Plus a defensive-fail-fast pattern on every supabase-js call in the route to prevent silent `{ data: null }` from masking the same class of bug again. Magnitude: ~770 Chicce / ~930 Vero products that currently look broken on the live preview are actually fine.

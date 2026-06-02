# Silent-null `.in()` batch scan

> 2026-06-02 | Companion to `docs/investigation/no-price-root-cause.md`. Maps every `.in()` + `slice()` batch site found via `grep` and classifies risk. Fixes applied to clearly-at-risk sites; ambiguous + safe sites recorded for reference.

## Risk model

The silent failure mode is:
1. `supabase-js` builds a URL with `?in.(...)=<comma-separated values>` for `.in()` filters.
2. The PostgREST proxy in Supabase rejects requests whose total HTTP header size exceeds ~16 KB (`UND_ERR_HEADERS_OVERFLOW`).
3. The error bubbles up through `undici` (Node 18+'s fetch) as a parser error, NOT a fetch error.
4. `supabase-js` catches it and returns `{ data: null, error: <object> }` — **but most call sites destructure only `data` and use `data ?? []`**, so the failure becomes silent.

500 UUIDs × ~36 chars + commas ≈ 18,200 chars in the URL → **always over the cap**. 100 UUIDs ≈ 3,600 chars → comfortably safe.

The risk applies to `.in()` on UUID fields, less so on numeric IDs (short) or short strings.

## At-risk sites — FIXED on this branch

| File:line | What it batches | Was | Now | Notes |
|---|---|---|---|---|
| `app/api/inventory/items/route.ts:184` | `aliasIds` (UUIDs) | 500 | 100 | Plus fail-fast on every supabase-js call in this route — silent `{data: null}` now returns HTTP 500 instead of a wrong-but-plausible response. The ROOT cause of the false 954/930 needs-attention numbers. |
| `app/api/inventory/items/route.ts:202` | `productIds` (UUIDs) | 500 | 100 | Same — preflight alias-count query. Was returning 0 aliases for everything → `no_article` flagged every product. |
| `lib/inventory/recipe-cost.ts:476` | `productIds` (UUIDs) | 500 | 100 | `getProductLatestPricesLeaf` — core price reader used by prep list, order list, recipes page, items API. **Most critical**: silent null here means missing prices across the entire app. Added `throw` on error. |
| `lib/inventory/recipe-cost.ts:495` | `productIds` (UUIDs) | 500 | 100 | Same function — alias→product map. |
| `lib/inventory/recipe-cost.ts:615` | `productIds` (UUIDs) | 500 | 100 | `getProductLatestPrices` (the public wrapper) — second products-table read for override + recipe-sourced detection. |
| `app/api/inventory/needs-review/approve/route.ts:148` | `ids` (UUIDs on `supplier_invoice_lines`) | 500 | 100 | Re-link approved lines. Existing `uErr` check, so silent null was caught — but the batch was still hitting the cap, returning partial results. |
| `app/api/inventory/needs-review/skip/route.ts:75` | `ids` (UUIDs) | 500 | 100 | Skip lines update. Existing error check. |
| `app/api/inventory/needs-review/skip/undo/route.ts:70` | `ids` (UUIDs) | 500 | 100 | Restore-from-skip update. Existing error check. |
| `app/api/cron/supplier-price-creep/route.ts:121` | `aliasIds` (UUIDs) | 500 | 100 | Daily cron. Silent null → no aliases → no products → no price-creep alerts. Added `throw` on error. |
| `app/api/inventory/retry-failed-extractions/route.ts:67` | `ids` (UUIDs on `invoice_pdf_extractions`) | 500 | 100 | Existing error check. |
| `app/api/admin/onboard/catalogue-autobuild/route.ts:296` | `ids` (UUIDs on `supplier_invoice_lines`) | 500 | 100 | Onboarding helper. Existing throw on error. |

## Sites already safe — confirmed in scan

| File:line | What it batches | Batch | Reason safe |
|---|---|---|---|
| `app/api/inventory/items/[id]/route.ts:71` | `aliasIds` | 200 | 200 UUIDs ≈ 7.3 KB — under cap with safety margin |
| `lib/inventory/recipe-cost.ts:508` | `aliasIds` | 200 | Same |
| `lib/inventory/ai-suggest-core.ts:302` | `keys` (group_key strings, ~20 chars each) | 200 | Short strings → small URL |
| `app/api/admin/customers/[orgId]/delete/route.ts:216` | `pathsToDelete` (storage paths) | 100 | Already conservative |
| `app/api/inventory/orders/build/route.ts:238` | `aliasIds` (UUIDs) | 50 | Already very conservative (post-audit) |
| `app/api/sync/now/route.ts:90` | `bizList` (numeric / small) | 5 | Tiny batches |
| `lib/scheduling/pk-sync.ts:282` | `shiftRows` | 500 | **`.upsert()` not `.in()`** — rows go in POST body, not URL. No header issue. |
| `lib/fortnox/voucher-cache.ts:132` | `cacheRows` | 500 | Same — `.upsert()` to POST body |

## The pattern to encode (for future code)

```ts
// CANONICAL pattern — batch size + fail-fast + log on suspect empty
const BATCH_IN = 100   // 100 UUIDs ≈ 3.6 KB URL, comfortably under 16 KB header cap
for (let i = 0; i < ids.length; i += BATCH_IN) {
  const slice = ids.slice(i, i + BATCH_IN)
  const { data, error } = await db.from('X').select(...).in('id', slice)
  if (error) {
    // Silent { data: null } would be a wrong-but-plausible result.
    // Loud failure here is the SAFER outcome.
    console.error('[X] batch lookup failed', { batch_size: slice.length, err: error })
    throw new Error(`[X] batch failed: ${error.message}`)
  }
  // ...
}
```

**Rules:**
1. **Never `i += 500` on `.in()` with UUIDs.** 100 is the canonical batch.
2. **Always destructure `error`.** Never `const { data } = await ...` for queries that filter on a non-empty input set.
3. **Throw or 500 on `error`**, don't soft-warn. A silent `{ data: null }` masquerading as `"this product has no aliases"` is the bug class.
4. **Suspect-empty logging**: when a query takes N input IDs and returns 0 rows, log loudly. This is what would have caught the original bug in an hour, not in production.

## What's NOT in scope here

- `.upsert()` with large arrays — body not URL, no header issue. Stays at 500.
- `.in()` with short strings or numeric IDs (< 100 chars total slice) — under cap. Stays.
- Cost-layer derivation logic — verified correct, no change.
- Schema, extractions, the prep / order / recipe engines beyond the batch reductions.

# Duplicate Products & Stranded Costs — READ-ONLY investigation

**Captured 2026-06-02 POST today's auto-repointer.** Source:
`scripts/diag/duplicate-products-step1.mjs` (fragmentation sizing)
and `scripts/diag/duplicate-products-step2.mjs` (stranded-cost
re-measure). Snapshots in `duplicate-products-{chicce,vero}-snapshot.json`.

---

## TL;DR (three-line summary)

1. **Fragmentation is large and concentrated.** Chicce: 383 products collapse to 146 clusters (frees 237 rows; 67 CLEAN, 79 AMBIG). Vero: 172 → 82 (frees 90 rows; 61 CLEAN, 21 AMBIG). 75 % of Chicce duplicates concentrated in two suppliers (Trädgårdshallen 179, Martin Servera 138 — both ship the same SKU under many invoice-description variants); Vero same shape (Spendrups 78, Martin Servera 41). Spread across product classes (vegetables, dairy, drinks, packaging), not random — name-variation noise.

2. **Stranded-cost is now SMALL — today's auto-repointer already absorbed the high-volume cases.** Chicce 151 recipe ingredients: **144 healthy (95.4 %)**, 3 stranded (cost recoverable via further consolidation), 4 genuinely missing. Vero 3 / 3 healthy. Recipe-level: 28 of 34 Chicce recipes fully complete; 3 recipes have stranded ingredients; 3 have only genuinely-missing prices. **Dedup is no longer a cost-recovery task — it's a catalogue tidy-up.**

3. **Right response: extend the auto-repointer with normalised-root candidate generation to catch the 3 stranded residue (one Haiku batch, ~$0.005), then do the catalogue tidy-up via the existing picker — concentrated by supplier (start with Trädgårdshallen + Spendrups), CLEAN clusters first (no judgment needed), AMBIG flagged for manual. Don't auto-collapse AMBIG — Lime "63st MX" vs "60st BR" might genuinely be different SKUs the supplier prices differently.**

---

## Step 1 — Fragmentation sizing

### Chicce

| Metric | Value |
|---|---|
| Active products | 1,248 |
| Duplicate clusters (≥2 products, same normalised root) | **146** |
| Total products in those clusters | 383 |
| Potential collapse | 383 → 146 (frees **237 rows**; 19 % of catalogue) |
| CLEAN clusters (same pack format across members) | 67 |
| AMBIG clusters (different pack formats — manual decision) | 79 |

**Top suppliers by duplicate-cluster product count:**

| Count | Supplier |
|---|---|
| 179 | Trädgårdshallen Sverige AB |
| 138 | Martin Servera Restauranghandel AB |
| 21 | AB Tingstad Papper |
| 19 | Laweka Gross & Matevent AB |
| 5 | RIMA Seafood AB |

317 of 383 (83 %) of duplicate-cluster products come from the top 2 suppliers — **concentrated**, not spread.

### Vero

| Metric | Value |
|---|---|
| Active products | 1,009 |
| Duplicate clusters | **82** |
| Total products in those clusters | 172 |
| Potential collapse | 172 → 82 (frees **90 rows**; 9 % of catalogue) |
| CLEAN clusters | 61 |
| AMBIG clusters | 21 |

**Top suppliers:**

| Count | Supplier |
|---|---|
| 78 | Spendrups |
| 41 | Martin Servera Restauranghandel AB |
| 29 | Snabbgross Örebro |
| 10 | SVENSK CATER AB |

148 of 172 (86 %) from the top 3 suppliers — same concentration shape as Chicce.

---

## Step 2 — Stranded-cost re-measure (the headline number)

### Chicce recipe ingredients (151 total, product-linked)

| Bucket | Count | % |
|---|---|---|
| **Healthy** (product has price) | **144** | **95.4 %** |
| Stranded on a duplicate | 3 | 2.0 % |
| Genuinely missing price | 4 | 2.6 % |

### Chicce recipes (34 with ≥1 product-linked ingredient)

| Bucket | Count |
|---|---|
| All ingredients healthy | 28 |
| Have stranded ingredient (cost recoverable via consolidation) | 3 |
| Only genuinely-missing prices | 3 |

### Vero

3 of 3 ingredients healthy; 1 of 1 recipe fully complete.

### The 3 remaining stranded cases at Chicce

| Recipe | Product (no price) | Sibling with price |
|---|---|---|
| Pinsa White Sauce | "Crema al formaggio Pecorino 580 gr" | "Crema al formaggio Pecorino 580g" |
| Västerbotten Cheese Arancini | "Panko ströbröd 1 kg" | "Ströbröd Panko 1kg" |
| Stracciatella with Brown Butter and Fig Jam | "Grapefrukt Röd 40st 15kg ZA" | "Grapefrukt Röd 45st (15kg) MA 1kg" |

All three are within the normalised-root reach of the auto-repointer's Jaccard heuristic but slipped through because either:
- Tiny name variation (space-vs-no-space, "580 gr" vs "580g") fell below the 0.30 Jaccard floor on the prior run, OR
- The sibling holding the price was itself recipe-referenced (Panko ströbröd — already flagged as a merge decision in today's run; same recipe just surfaced differently in this scan).

A re-run of the auto-repointer with **normalised-root candidate generation instead of Jaccard** would likely auto-resolve the Crema and Grapefrukt cases on the next pass (~$0.005 in Haiku tokens). Panko stays an owner merge decision (sibling is in 2 recipes).

---

## Step 3 — Right response (scope, don't build)

### Catalogue tidy-up — supplier-concentrated, manual where ambiguous

**Chicce CLEAN clusters (67):** safe to systematic-collapse. Within each cluster, pick the most-recent-used product as canonical, repoint all sibling aliases onto it, archive the emptied duplicates. The repoint endpoint already does the alias-pointer move non-destructively + reversibly. **Estimated reduction: ~67 → 67 (no row change since each cluster already has one canonical) plus 100+ stripped duplicate rows.**

**Chicce AMBIG clusters (79):** manual decision only. The "Lime 63st MX" vs "Lime 60st BR" example — both probably the SKU "Lime fresh, sold in 60-pack" but the supplier ships from different origins with slightly different count-per-pack. Could legitimately be one product (kitchen doesn't care about origin) OR genuinely different (cost differs by origin). **Owner judgment per cluster** via the EditItemModal picker.

**Vero same shape:** 61 CLEAN, 21 AMBIG.

### Why NOT auto-collapse AMBIG

- "Burrata 125g" (single 125g ball) vs "Burrata 3x100 gr" (3-pack of 100g balls): pack and SKU differ. Buying one when you need the other isn't the same thing.
- "Paprika Röd 5kg ES" (Spain) vs "Paprika Röd 70+ 5 Kg PL" (Poland, grade 70+): supplier ships under separate article codes; price varies; kitchen may prefer one quality grade.
- "Grapefrukt Röd 40st 15kg ZA" vs "Grapefrukt Röd 45st (15kg) MA 1kg": same case weight but different per-fruit size class and origin.

The Loka-vs-Lokalhyra discipline applies — lexical similarity is a candidate filter only; pack-format differences carry real meaning that an automated collapse can't read.

### Recommended sequence

1. **Re-run the auto-repointer with normalised-root candidates** (one tiny build, ~30 min) → clears the 3 Chicce stranded residue if the sibling is orphan; flags Panko-class merges for owner.

2. **Catalogue tidy-up pass (CLEAN clusters only)** as a new script — supplier-grouped, deterministic merge by picking the most-recent-used member of each cluster as canonical, repointing all sibling aliases. Restricted to clusters where pack_size + base_unit match exactly. Estimated: clears ~128 duplicate rows at Chicce (67 CLEAN × ~2 sibling-rows each on average) and ~61 at Vero. ~5 min runtime.

3. **AMBIG clusters left for owner review** via existing EditItemModal picker (matched-elsewhere bucket already surfaces these). Could surface a "Possible duplicates of this product" hint on the items detail page if volume justifies; currently 79 + 21 = 100 ambig clusters is borderline.

### Magnitude estimates if (1)+(2) ship

| | Chicce | Vero |
|---|---|---|
| Stranded ingredients resolved | 2 of 3 (Panko stays manual) | 0 |
| Catalogue rows freed (archived duplicates) | ~128 of 237 (CLEAN only) | ~61 of 90 |
| Catalogue size reduction | ~10 % | ~6 % |
| Recipes that go from incomplete → complete | 2 of 6 incomplete | 0 |

The cost-recovery upside is small — **dedup is now a tidy-up exercise, not a financial one.** Today's auto-repointer captured the value; further work is operational hygiene.

---

## Queries (read-only, all SELECT)

All listed in `scripts/diag/duplicate-products-step1.mjs` and
`step2.mjs`. Key patterns:

- `products` select with `business_id` + `is null archived_at` filter (paginated 1000/req)
- `recipe_ingredients` select via `recipe_id in (recipeIds)` two-step (PostgREST dual-FK)
- `product_aliases` select via `product_id in (productIds)` batched 100/req (silent-null protection)
- `supplier_invoice_lines` select via `product_alias_id in (aliasIds)` batched 200/req

No merges, no writes performed.

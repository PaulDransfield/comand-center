# Pack info from supplier_articles — v2 architecture

**Built 2026-06-03 in response to "every thing cross references correctly with the new product details" + "lets fix it so there is no future issues".**

The MS scrape (commits 5037d8b → completion 2026-06-03 09:08, 680 articles cached with images + specs) gives us authoritative pack info per supplier article. The v1 promoter (`scripts/diag/promote-supplier-weights.mjs`) was lossy — it wrote `net_weight_g` blindly as `pack_size`, which made things WORSE for multi-pack cartons, volume products, and weight-sold (Viktvara) items. **The v1 script is now obsolete and should not be run.**

## Components shipped

### 1. `lib/inventory/pack-from-supplier-article.ts` (pure helper)
Single source of truth for translating a supplier_articles row → (pack_size, base_unit). Six branches with explicit priority:

| # | Branch                    | Trigger                                              | Output                |
|---|---------------------------|------------------------------------------------------|-----------------------|
| 1 | `count_carton`            | Label "N st/..." (12 st/Kartong, 250 st/Innerförp.)  | pack=N, base='st'     |
| 2 | `volume_from_label`       | Label "X l/..." or "X cl/..." or "X ml/..."           | pack in ml            |
| 3 | `volume_from_name`        | Name has clean volume token (70cl, 1L, 500ml), unit ≠ KRT/BACK | pack in ml |
| 4 | `viktvara`                | Label "Viktvara" + unit=KG (sold by kg)              | pack=1000, base='g'   |
| 5 | `single_container_weight` | Unit ∈ {DUNK, BURK, HINK, PKT, FRP, PÅSE, SÄCK, IFRP, KG, ASK, BACK} OR unit=ST with "X kg/Styck" | pack=net_weight_g, base='g' |
| 6 | `multi_pack_count`        | unit=KRT, label "X kg/Kartong", name parses N-pack + per-pack weight | pack = N × sub_packs, base='st' |
| — | `skip`                    | None matched — leave product alone                   | —                     |

Branch ORDER matters. The label is the load-bearing discriminator: "0,70 l/Styck" means **volume** (Branch 2) even though net_weight_g is set, because the label explicitly says litres.

### 2. `scripts/diag/promote-supplier-weights-v2.mjs` (backfill driver)
Walks supplier_articles → invoice lines → aliases → products and applies the helper. Conservative gates:

- **Never overwrites** `pack_source='owner_set'`
- **Skips** when current value already equals proposed (no-op)
- **Skips + reports** when current `pack_source='name_parsed'` AND proposed disagrees by >2× OR uses a different unit family (conflict for owner review)
- **EXCEPTION** to skip: if current value is < 10 (clearly Swedish-comma-as-decimal bug like "1,785g" parsed as 1.785), allow the override. Catches the egg-class "Ägg M Krav 30p 1,785g" → 1.785 g bug.

### 3. `lib/inventory/matcher.ts` createProductFromLine integration
**The "no future issues" leg.** When the matcher creates a new product from a supplier invoice line, the resolution order is:

1. **supplier_articles** (the scrape-fed ground truth) — set when (supplier, article_number) maps to a `supplier_articles` row with a derivable pack via the helper. Tagged `pack_source='supplier_official'`.
2. **Name parser** — existing `parseProductPackSize("Olja Rapsolja 10 liter")` → 10000 ml.
3. **Invoice unit fallback** — "Citron / KG" → 1000 g.
4. Null — owner review later.

So as new invoices come in (and the MS scrape is kept fresh), products are born with correct pack info — no future backfill needed.

## Current DRY state (Chicce + Vero combined, 2026-06-03)

```
725 supplier_articles rows loaded
738 aliases pointing at scraped articles
685 distinct products considered

Proposals by branch:
  count_carton:             32
  volume_from_label:         6
  volume_from_name:         13
  viktvara:                  7
  single_container_weight:  33
  multi_pack_count:          0
                          ───
  Total:                    91   (safe to auto-apply)

Skipped:
  owner_set:                 0   (no protected values affected)
  no_change:               330   (already matches MS data)
  conflict:                 47   (>2× disagreement — needs owner review)
  branch_skip:             217   (MS data doesn't match any branch — leave alone)
```

The 47 conflicts are recorded in `promote-supplier-weights-v2-dry.txt`. Two common shapes:

1. **Viktvara conflict** (Champinjon, Kalvytterfile, Chorizo, Manchego): customer bought a 2.5kg or 3kg whole piece; product correctly stores per-piece weight; MS Viktvara branch wants 1000g standard. **Resolution:** keep name_parsed value (cost engine already uses the line's per-piece unit_price).
2. **Multi-pack case conflict** (Pannoumi 12x90g, Quinoa Röd 500g): MS sells the case (1080g, 3000g); customer's invoice unit matches sub-pack (90g, 500g). **Mathematically equivalent** for cost (same per-g price), so either is fine — but the owner-facing name should match what they recognise. **Resolution:** keep name_parsed.

## Why multi_pack_count is empty

The branch fires on `unit=KRT + label "X kg/Kartong" + name has Np + per-pack g`. Existing Ägg products at Chicce already have name_parsed values that the conflict heuristic correctly identifies as alternative valid framings (per-pack g vs per-carton st). The egg products at Chicce + Vero are 6 of the 47 conflicts. **Resolution:** these need explicit owner-direction — should recipes ask in 'st' (count) or 'g' (weight)? Current name_parsed (in g) lets the cost engine resolve cost-per-g but not cost-per-egg. If the chef thinks in count, switching to st via the multi_pack_count branch would be cleaner.

## How to apply

**DRY** (always):
```
node scripts/diag/promote-supplier-weights-v2.mjs
```

**Per-branch apply** (owner decides):
```
node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=1   # count_carton
node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=2   # volume_from_label
node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=3   # volume_from_name
node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=4   # viktvara
node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=5   # single_container_weight
node scripts/diag/promote-supplier-weights-v2.mjs --apply --branch=all
```

The conflict list stays on owner review until either (a) the heuristic improves OR (b) owner inspects + manually sets `pack_source='owner_set'`.

## Next steps (parked)

1. **Cost-engine last-mile fallback** (parked): when a product has no pack info but its latest supplier line maps to a scraped supplier_article, derive the pack on-the-fly. Adds another belt-and-braces layer without writing to products.
2. **Bulk recipe importer** still creates products without consulting supplier_articles. Next iteration should check supplier_articles by official_name BEFORE creating a new product — eliminates the "Mascarpone 47% 2kg" vs "Mascarpone 48% 2kg" duplicate class.
3. **Periodic supplier_articles refresh cron** (parked): MS catalogue changes over time (new SKUs, weight tweaks). A monthly re-scrape would keep ground truth fresh.

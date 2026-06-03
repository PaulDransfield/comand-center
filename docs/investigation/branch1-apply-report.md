# Branch 1 apply report — for second-opinion review

**Date:** 2026-06-03
**Branch:** `single_container_weight` (a stale slug map mapped `--branch=1` to this instead of `count_carton` — only single-container weights were applied; the count-carton + other branches still need separate decisions.)
**Apply scope:** products at Chicce (30) + Vero (3) where `pack_source` was NULL or `invoice_unit_inferred` AND the MS supplier_article row's `unit` is a single-container type (DUNK / BURK / HINK / PKT / FRP / PÅSE / SÄCK / IFRP / KG / ASK / BACK) — OR `unit=ST` with label `"X kg/Styck"`, which means the buy unit is a single-piece weight container.
**Output:** `products.pack_size`, `products.base_unit`, `products.pack_source='supplier_official'`. Never overwrites owner-set values.

## Helper rule (deterministic)

`lib/inventory/pack-from-supplier-article.ts` — single source of truth. Six branches with explicit priority:

1. `count_carton` — label `"N st/..."`
2. `volume_from_label` — label `"X l/..." / "cl/" / "ml/"`
3. `volume_from_name` — name has clean volume token (no `/styck` label)
4. `viktvara` — label `"Viktvara"` + unit=KG → 1000g
5. `single_container_weight` — unit ∈ single-container set OR unit=ST with `"X kg/Styck"` label → `pack_size = net_weight_g`, `base_unit='g'`
6. `multi_pack_count` — unit=KRT + label `"X kg/Kartong"` + name parses `Np` and per-pack weight

## What was applied

33 product rows updated. Below is the full list (`pack_size base_unit · invoice_unit · name`):

**Chicce (30):**
```
1785 g  · ST    · Ägg Lv M Krav 30p 1,785g          ← Swedish-comma override caught
170 g   · ST    · Avocado Mogen Softripe
2500 g  · ST    · Blandfärs 50/50 15% Kyse2
2500 g  · ST    · Blandfärs 50/50 23% Kyeu2
2500 g  · ST    · Chokl Mörk Pell 54,5% 2,5k
1500 g  · ST    · Feta Ost Spillbit Pdo 1kg         ← MS net=1500g vs name 1000g (>2× exempt? no — both g)
1500 g  · ST    · Fetaost Ekfatslag Skiv 1kg
3150 g  · BURK  · Fetaost Hel Eko 2kg               ← BURK + 3150g (case of 1 or 1.5×?)
50 g    · ST    · Fikon St
2450 g  · ST    · Kronärtskocka Romana 2,45k
83 g    · ST    · Lime St
400 g   · FRP   · Lock T Fat 47x32cm H11cm 5
2500 g  · ST    · Majsstärkelse Maizena 2,5k
1700 g  · ST    · Mozzarella Cocktail 8g/1kg
4100 g  · ST    · Mutti Pizzasås Classi 4,1k
3800 g  · ST    · Oliv Svart Urkärnad 3kg            ← MS net=3800g vs name 3000g (drained vs not)
1405 g  · ST    · Patron Gräddsifon 50p No2
2500 g  · ST    · Räka I Lake Msc 1,5kg              ← MS net=2500g vs name 1500g (case?)
2700 g  · ST    · RÄKA LAKE HSK MSC 1,5KG            ← same — dup product, see below
5000 g  · ST    · Risoni Påse
300 g   · ST    · Sallad Frisee Fine St
250 g   · ST    · Sallad Roman Se
80 g    · ST    · Salvequick Sårvätt Ref 20s
380 g   · ST    · Sambal Harissa Chilipa 380
532 g   · ST    · Taco Original Spicemix 532
1000 g  · ST    · Tomat Semitork Mar Hack 1k
2300 g  · ST    · Tomat Solt Marinad Str 2,3
1700 g  · ST    · Tomat Soltork Str Olja 1,7
950 g   · ST    · Tyllpåse Halkfri Eng Blå72
1000 g  · ST    · Violife Mozzar Flav Riv 1k
```

**Vero (3):**
```
400 g  · ST  · Blekselleri EKO
450 g  · ST  · Svartpeppar Hel Tellic 450
1082 g · ST  · Tasty Hambost Lätt 1,08kg
```

## Concerns I want a second opinion on

### 1. Slug map bug — fixed but did rename branches in the report

The DRY report shows branches in this order: `count_carton, volume_from_label, volume_from_name, viktvara, single_container_weight, multi_pack_count`. But `--branch=1` was wired to `single_container_weight` because the slug map predated the algorithm refactor. **Fixed in the same commit-cycle** so future `--branch=N` matches the DRY display order:
```
1 = count_carton
2 = volume_from_label
3 = volume_from_name
4 = viktvara
5 = single_container_weight   ← this is what was just applied
6 = multi_pack_count
```

**Is this a problem?** The applied work is internally consistent and matches what the safest branch should do. But the user explicitly typed `--branch=1` expecting count_carton. Worth flagging.

### 2. Several products got values that differ noticeably from their name-parsed value

These didn't go through the "conflict skip" because the previous `pack_source` was either NULL or `invoice_unit_inferred` (a guess), not `name_parsed`. Spotchecks:

- **"Feta Ost Spillbit Pdo 1kg" 1000g → 1500g** — MS art 127135 says net=1500g. Name says 1kg. Likely MS sells "spillbit" (offcuts) at ~1.5kg drained weight per BURK; the 1kg is brine-only? Cost-engine result: same per-line price ÷ 1500 vs ÷ 1000 = 33% cheaper per gram. **Recipe-cost impact: meaningful.**
- **"Räka I Lake Msc 1,5kg" 1500g → 2500g** — MS net=2500g, name 1500g. This is drained-vs-undrained weight. **Same recipe-cost concern.**
- **"RÄKA LAKE HSK MSC 1,5KG" 1500g → 2700g** — same drained-vs-undrained AND this is a likely duplicate of the above. Need dedup pass.
- **"Oliv Svart Urkärnad 3kg" 3000g → 3800g** — net (jar contents incl. brine) vs drained olive weight.

**Question for review:** for drained-weight products (olives, capers, sundried tomatoes in oil, shrimp in brine, etc.), which should the recipe-cost engine use — net (jar contents) or drained? Chef likely says "100g of olives" meaning drained. But invoice unit-price covers undrained mass. Today's choice: trust MS net. Defensible but worth sanity-checking with the owner.

### 3. Egg row went from buggy 1.785g → 1785g (correct)

The Swedish-comma-as-decimal exception fired: previous `name_parsed=1.785g` (which is obviously wrong — eggs aren't milligrams) overridden to MS's `1785g`. This was the intended override path for an obvious parser bug. **Looks right.**

## What was NOT applied (47 conflicts, deferred for owner review)

The conflict heuristic skipped these because the existing `name_parsed` value disagreed by >2× AND the current value is plausible. Two patterns:

### Viktvara overreach (8 conflicts at Chicce/Vero)
MS catalogue's "Viktvara" articles have a generic 1kg standard pack. The customer actually buys a 2.5kg / 3kg / 5kg whole piece. Name parsing already captured the actual piece weight. Cost engine works correctly with the existing value (since unit_price is per piece). **Recommendation: keep skipping these — name_parsed wins.**

Examples:
```
KYCKLFILE KY 2,5KG               2500g → MS implies 1000g  (Viktvara)
Kalvhögrev Rose Nl 5kg           5000g → MS implies 1000g  (Viktvara)
Manchego 6 mån 37% 3kg           3000g → MS implies 1000g  (Viktvara)
Chorizo Ibérico 1/4kg            4000g → MS implies 1000g  (Viktvara)
```

### Case-vs-piece ambiguity
MS sells a case; customer's product is named at the piece level. Mathematically equivalent for cost (same per-g unit cost).

```
Kikärtor Påse 3kg Lin           3000g → MS 15000g (case of 5×3kg)
Pannoumi Stek Skiv 12x90g        90g → MS 1080g (case of 12×90g)
Quinoa Röd 500g S                500g → MS 3000g (case of 6×500g)
Tortilla Wrap 28cm 110g/1,       110g → MS 6600g (case of 60×110g)
```

**Recommendation: keep skipping — the user-facing name says "3kg påse", confusing them with 15kg would hurt readability.**

### Multi-pack count carton (6 egg products)
`Ägg Lv L Frig 30p 2,04kg`: current pack=2040g (per-pack mass), MS implies 120st (per KRT). Same product, different framings. **Recommendation: this is the only branch where MS framing arguably wins — recipes ask "18 eggs" not "1170g of egg". But: the Lemon Curd egg product (`ÄGG LV FRIGÅENDE M 30P`) is auto-resolved via the items-page "Detect pack size" button using the Phase 2 name-match consensus rule. That's the recommended path; the bulk script can stay skipped on these.**

### One label-volume conflict
```
Hönsbuljong Pasta 1kg            1000 g → MS 1000 ml (label says "1,00 l/Styck")
```
Hönsbuljong paste at 1L/styck is genuinely a 1L tub. But the name parser saw "1kg" and stored grams. Both work for cost calc since 1L ≈ 1kg at cooking density. Cosmetic conflict; either is fine.

## Verification checklist for second opinion

1. **Are the 33 applied values sensible?** Look at the Chicce list — anything that should NOT have changed?
2. **The drained-vs-undrained weight question** for olives/shrimp/feta-in-brine — what's the right convention?
3. **The dup at Chicce**: `Räka I Lake Msc 1,5kg` and `RÄKA LAKE HSK MSC 1,5KG` both got `pack_source='supplier_official'` with different values (2500g vs 2700g). Two products, two MS articles, but they're the same SKU. Probably a duplicate-cluster the dedup script missed. Should I run `clean-clusters-dedup.mjs` over the supplier_official rows now that they're tagged?
4. **The viktvara skip policy** — keep skipping is the safe call, right? Don't want to overwrite "5kg whole piece" with "1kg standard".

## Files involved (current main)

- `lib/inventory/pack-from-supplier-article.ts` — canonical helper (6 branches)
- `lib/inventory/matcher.ts` `createProductFromLine` — new products consult supplier_articles at birth
- `app/api/inventory/items/backfill-pack-size/route.ts` — "Detect pack size for all" button consults supplier_articles (article-number + name-match Phase 2 with consensus tie-handling)
- `scripts/diag/promote-supplier-weights-v2.mjs` — backfill driver (DRY default, per-branch apply)
- `docs/investigation/pack-from-supplier-article.md` — architecture doc
- `docs/investigation/promote-supplier-weights-v2-dry.txt` — full DRY output incl. all 47 conflicts
- `docs/investigation/promote-branch1-apply.txt` — this apply session's full output

## Remaining branches (DRY counts, not yet applied)

```
count_carton:        32 proposals  (mostly ∅→N st, paperwork/disposables)
volume_from_label:    6 proposals  (Monin 70cl, Ättiksprit 10L, etc.)
volume_from_name:    13 proposals  (clean volume parses)
viktvara:             7 proposals  (the 7 that DIDN'T conflict — no existing pack)
multi_pack_count:     0            (egg-class went to conflicts, deliberately)
```

Owner direction needed per-branch on what to do next.

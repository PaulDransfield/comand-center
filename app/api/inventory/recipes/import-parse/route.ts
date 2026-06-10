// app/api/inventory/recipes/import-parse/route.ts
//
// Owner-facing AI bulk recipe importer — PARSE step.
//
// Owner pastes a menu (one dish per line, or freer-form text) → Sonnet
// drafts each dish with ingredient quantities drawn from the existing
// product catalogue. Returns the drafts without writing anything — the
// owner reviews them in the UI, edits any quantities/products that look
// wrong, then a separate save step bulk-inserts via the existing
// /api/inventory/recipes POST + /[id]/ingredients POST endpoints.
//
// Reuses the proven prompt + catalogue-prefix-matching pattern from
// /api/admin/onboard/recipes-draft, but owner-facing instead of admin
// (AI-quota-gated, scoped to the caller's businesses).
//
// POST { business_id, menu_text }
//   → { drafts: [{ name, portions, ingredients: [{ product_id, product_name, quantity, unit }] }], tokens_in, tokens_out }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess, requireOperator } from '@/lib/auth/require-role'
import { AI_MODELS } from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

const MAX_DISHES      = 40    // Sonnet handles this in one call comfortably
const MAX_CATALOGUE   = 1500  // product context cap. Bumped from 400 after
                              // the Chicce truncation incident — alphabetical
                              // sort meant any product past letter G never
                              // entered Sonnet's context (Mozzarella at 691,
                              // Parmigiano at 783, Ruccola at 943). 1500
                              // comfortably fits Chicce's 854 food products
                              // and Vero's ~600 within ~25k input tokens.
const MAX_INPUT_CHARS = 8000  // ~2000 tokens of menu text; owner can iterate

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── Input modes ───────────────────────────────────────────────────
  // (a) JSON body { business_id, menu_text }                  — paste
  // (b) multipart form { business_id, file, file, … }         — upload
  //   Multiple files concatenated into a single Sonnet call so the
  //   model sees ALL inputs at once (cross-file sub-recipe refs work
  //   automatically — sauce defined in File A, used in File B's
  //   pinsa, both get linked). Per-file handling:
  //     PDF / image → Sonnet doc/image content block
  //     Word .docx  → server-side mammoth → text, concatenated with
  //                   visible header delimiters
  let businessId = ''
  let menuText   = ''
  let category: 'food' | 'drinks' = 'food'
  // Mixed PDF + Word + image upload becomes a list of content blocks
  // appended to the user message. Word docs collapse to text and
  // append to menuText with a header so the model can tell files apart.
  type FileBlock =
    | { kind: 'pdf';   name: string; base64: string }
    | { kind: 'image'; name: string; base64: string; mediaType: string }
  const fileBlocks: FileBlock[] = []

  const MAX_FILES       = 10
  const MAX_TOTAL_BYTES = 25 * 1024 * 1024  // 25 MB total across files

  const contentType = req.headers.get('content-type') ?? ''
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData().catch(() => null)
    if (!form) return NextResponse.json({ error: 'invalid form data' }, { status: 400 })
    businessId = String(form.get('business_id') ?? '').trim()
    const cat  = String(form.get('category') ?? 'food').trim().toLowerCase()
    category   = cat === 'drinks' ? 'drinks' : 'food'
    // Accept any number of files under the 'file' field. Owners can
    // also drop in a single file (back-compat with previous v1 path).
    const rawFiles = form.getAll('file').filter((f): f is File => f instanceof File)
    if (rawFiles.length === 0) return NextResponse.json({ error: 'at least one file required in multipart form' }, { status: 400 })
    if (rawFiles.length > MAX_FILES) {
      return NextResponse.json({ error: `too many files (${rawFiles.length} > ${MAX_FILES})` }, { status: 400 })
    }
    let totalBytes = 0
    const wordSections: string[] = []
    for (const file of rawFiles) {
      const bytes = Buffer.from(await file.arrayBuffer())
      totalBytes += bytes.length
      if (totalBytes > MAX_TOTAL_BYTES) {
        return NextResponse.json({ error: `total upload size exceeds ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB` }, { status: 400 })
      }
      const fname = (file.name ?? '').toLowerCase()
      const ftype = (file.type ?? '').toLowerCase()
      if (fname.endsWith('.pdf') || ftype === 'application/pdf') {
        fileBlocks.push({ kind: 'pdf', name: file.name, base64: bytes.toString('base64') })
      } else if (fname.endsWith('.docx') || ftype.includes('officedocument.wordprocessingml')) {
        try {
          const mammoth = (await import('mammoth')).default ?? (await import('mammoth'))
          const r = await mammoth.extractRawText({ buffer: bytes })
          const text = (r?.value ?? '').trim()
          if (text) wordSections.push(`── ${file.name} ──\n${text}`)
        } catch (e: any) {
          return NextResponse.json({ error: `Could not read Word document ${file.name}: ${String(e?.message ?? e)}` }, { status: 400 })
        }
      } else if (fname.match(/\.(jpe?g|png|webp|gif)$/i) || ftype.startsWith('image/')) {
        const mediaType = ftype.startsWith('image/') ? ftype : ('image/' + (fname.match(/\.(\w+)$/)?.[1] ?? 'jpeg').replace('jpg', 'jpeg'))
        fileBlocks.push({ kind: 'image', name: file.name, base64: bytes.toString('base64'), mediaType })
      } else {
        return NextResponse.json({ error: `Unsupported file type for ${file.name}. PDF, Word (.docx), or image only.` }, { status: 400 })
      }
    }
    // Concatenate any Word-extracted text into menuText with header
    // separators so the model can identify which dishes came from which
    // file (helps when the same dish name appears in two docs).
    if (wordSections.length > 0) menuText = wordSections.join('\n\n')
  } else {
    let body: any
    try { body = await req.json() } catch { body = {} }
    businessId = String(body?.business_id ?? '').trim()
    menuText   = String(body?.menu_text   ?? '').trim()
    const cat  = String(body?.category    ?? 'food').trim().toLowerCase()
    category   = cat === 'drinks' ? 'drinks' : 'food'
  }

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  // Either menuText OR at least one file must be present.
  if (!menuText && fileBlocks.length === 0) return NextResponse.json({ error: 'menu_text or file(s) required' }, { status: 400 })
  if (menuText && menuText.length > MAX_INPUT_CHARS * 4) {
    return NextResponse.json({ error: `input too long (${menuText.length} chars)` }, { status: 400 })
  }

  const op = requireOperator(auth)
  if (op) return op
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // AI-quota gate. checkAndIncrementAiLimit is the right shape per
  // CLAUDE.md Session 21 invariants — atomic on user-triggered endpoints.
  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  // Catalogue context — owner gets recipes that draw from THEIR
  // catalogue, not hallucinated names.
  //
  // Filter to food + beverage + alcohol categories only. Cleaning
  // supplies, disposables, takeaway packaging wouldn't be ingredients
  // in any sane recipe and just steal tokens. Caught the prior
  // Chicce truncation bug (164 non-edible products pushed real
  // ingredients past the 400-product cutoff).
  const { data: products } = await db
    .from('products')
    .select('id, name, category, invoice_unit, base_unit')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .in('category', ['food', 'beverage', 'alcohol'])
    .order('name')
    .limit(MAX_CATALOGUE)

  if (!products || products.length === 0) {
    return NextResponse.json({
      error:   'catalogue_empty',
      message: 'No products in this business yet — set up the catalogue (Inventory → Articles) before bulk-importing recipes, so the AI has ingredients to reference.',
    }, { status: 409 })
  }

  const prodByPrefix = new Map<string, any>()
  for (const p of products) prodByPrefix.set(p.id.slice(0, 8), p)

  const catalogueText = products.map((p: any) =>
    `  [${p.id.slice(0, 8)}] ${p.name} (cat:${p.category ?? '?'}, unit:${p.invoice_unit ?? p.base_unit ?? '?'})`
  ).join('\n')

  // SYSTEM_PROMPT mirrors the admin recipes-draft version with one
  // difference: input is free-form text (menu paste), not pre-parsed
  // menu items. Tell Sonnet to first identify dishes from the text, then
  // draft ingredients per dish.
  //
  // Two flavours: food (default) and drinks. Drinks knows about the
  // wine/cocktail/beer menu format (glass/bottle dual pricing, vintage
  // year prefix, cocktail ingredient lists without quantities).
  const SYSTEM_PROMPT_DRINKS = `You are an expert sommelier and bartender drafting a Swedish restaurant's DRINKS menu into a structured catalogue. The owner has pasted their drinks list. Your job:

1. Identify each distinct DRINK in the input. Skip section headers (BIANCO / ROSSO / ROSATO / BOLLICINE / FAT 40CL / FLASKA 33CL / COCKTAILS etc) — focus on item names.
2. For each item, draft a recipe entry pointing at the matching supplier product where applicable.

── DRINK TYPES — set the "type" field on EVERY drink ──

- wine        — bottled wine (red, white, rosé, bubbles): always has a producer name and usually a vintage year. May have dual pricing "glass/bottle:-" (e.g. 135/610:-).
- beer        — bottled or draft beer (lager, IPA, stout, etc.).
- spirit      — bottled distillates (gin, vodka, whisky, rum, etc.), sold by the glass.
- softdrink   — sodas, juices, mixers (Coca-Cola, San Pellegrino, Festis, tonic, etc.)
- cocktail    — multi-ingredient mixed drinks; will have an ingredient list in the menu.
- cider       — apple/pear cider products.
- alcohol_free — alcohol-free wines, beers, spritzes, mocktails — anything explicitly marketed as 0.0%.
- drink       — fallback when none of the above fits.

── WINE FORMAT ──

Italian/French/etc. wine lines typically look like:
  "2024 Erste + Neue - Riesling - Trentino Alto Adige   165/745:-"
  "2024 Albino Rocca Langhe da Bertü - Chardonnay   800:-"
  "NV Il Fattorino Bianco - Vermentino, Viogner, Malvasia - Marche   110/495:-"

Parse:
  - vintage_or_NV (year, "NV" = non-vintage)
  - producer + wine name
  - grape variety
  - region (optional)
  - glass_price / bottle_price OR just bottle_price

Build the recipe's "name" as: "[vintage] Producer + Wine Name" (e.g. "2022 Cecchi Chianti Classico"). Keep grape and region in the "note" field. Set portions=6 (standard EU 125 ml pour from a 750 ml bottle — owner can edit per-wine). When dual price is given, set selling_price_inc_vat to the BOTTLE price and glass_price_inc_vat to the glass price. When only one price is given, set selling_price_inc_vat only.

── BEER / SPIRIT / SOFTDRINK / CIDER FORMAT ──

Single-line items with one price:
  "Poretti lager   90:-"
  "Coca-Cola Co. 33cl   40:-"
  "Mikkeller 33cl   75:-"

Build name as the brand + descriptor. selling_price_inc_vat = the listed price. portions=1. No glass_price.

── COCKTAIL FORMAT ──

Cocktails typically have a name + ingredient list + one price:
  "Negroni   160:-
   Tanqueray Gin, Campari, Carpano Classico"

Build name = cocktail name. selling_price_inc_vat = price. portions=1. Ingredient list goes into the ingredients array with qty/unit BLANK (set qty=0, unit="ml") — the bartender fills the recipe pour-spec later. Reference each spirit/mixer by the closest catalogue product prefix \`p\`.

── INGREDIENT MATCHING ──

For ALL drink types, link each spirit/wine/mixer/garnish to the closest catalogue product prefix \`p\` when one plausibly exists.

- Wine: look for a product whose name contains both the producer and vintage. If catalogue has "Chianti Classico Cecchi 2022 75cl", that's the match.
- Beer: look for the brand name in product names ("Poretti", "Peroni", "Carlsberg alkoholfri").
- Spirit: look for brand + size ("Tanqueray Gin 70cl", "Campari 100cl").
- Softdrink: brand + size match ("Coca-Cola 33cl Engångsglas", "San Pellegrino 25cl").

If the wine/spirit isn't in the catalogue yet, omit the ingredient (set ingredients=[]) and add a note "Catalogue product missing for [name]" — owner will create the product later, then link the recipe ingredient.

Quantities for cocktail ingredients: leave qty=0 for chef to fill, unit="ml". For wine bottle / beer can / spirit pour: qty=1, unit="st" or "flaska" or "bottle". (Cost engine handles either.)

Up to ${MAX_DISHES} drinks per import.

Return JSON ONLY:
[
  {
    "name":     "2022 Cecchi Chianti Classico",
    "type":     "wine",
    "portions": 6,
    "selling_price_inc_vat": 610,
    "glass_price_inc_vat":   135,
    "note":     "Sangiovese — Toscana.",
    "ingredients": [{ "p": "abcd1234", "qty": 1, "unit": "flaska" }]
  },
  {
    "name":     "Poretti lager",
    "type":     "beer",
    "portions": 1,
    "selling_price_inc_vat": 90,
    "ingredients": [{ "p": "wxyz5678", "qty": 1, "unit": "st" }]
  },
  {
    "name":     "Negroni",
    "type":     "cocktail",
    "portions": 1,
    "selling_price_inc_vat": 160,
    "note":     "Tanqueray Gin, Campari, Carpano Classico — owner sets pour-spec.",
    "ingredients": [
      { "p": "aaaa1111", "qty": 0, "unit": "ml" },
      { "p": "bbbb2222", "qty": 0, "unit": "ml" },
      { "p": "cccc3333", "qty": 0, "unit": "ml" }
    ]
  }
]`

  const SYSTEM_PROMPT_FOOD = `You are an expert head chef costing a Swedish restaurant's menu. The owner has pasted their menu as free-form text. Your job:

1. Identify each distinct DISH in the input. Skip section headers, intros, footers — focus on dish names.
2. For each dish, draft a per-portion ingredient list drawn ONLY from the supplier product catalogue (reference each by its [8-char prefix]).
3. If a dish has a selling price in the input, capture it as selling_price_inc_vat; else leave it null.

── INGREDIENT MATCHING (this is where most drafts fail) ──

Menu language (chef writing) and catalogue language (supplier descriptions) diverge constantly. Match by **what the ingredient IS**, not by string similarity. Examples:

- Menu says "mozzarella"  → match catalogue "Mozzarella per pizza Julienne 2,5kg" or similar (any mozzarella product).
- Menu says "parmesan"    → match "Parmigiano Reggiano DOP" or "Pecorino" (Italian hard cheeses are the chef's "parmesan").
- Menu says "parmaskinka" → match "Prosciutto di Parma" (parma ham). Look for "prosciutto", "skinka", "ham".
- Menu says "ruccola"      → match "Ruccola 200g" or "Ruccola Tvättad 4x500g" (any rocket/arugula).
- Menu says "olivolja"     → match "Olivolja Extra Jungfru" or similar olive oil.
- Menu says "tomatsås"     → match "Pizzatomater", "Mutti Polpa", "Hela Tomater" (any tomato product suitable as a sauce base).
- Menu says "basilika" / "basil" → match "Basilika 100g" or "Basilika Färsk".
- Menu says "pinsa base" / "pizzabotten" → match "Pinsa Base", "FRYS Base pizza", or similar.

The menu is often bilingual (Swedish + English) — both refer to the same ingredient. Translate freely.

RULES:
- Use ONLY product prefixes that appear in the catalogue. Never invent a product.
- For each menu ingredient, scan the ENTIRE catalogue for ANY product that could plausibly fill the role. Don't give up if the chef's word doesn't appear verbatim.
- Quantities are PER PORTION and realistic for the dish:
  * Pinsa/pizza: 200-300g base + 60-100g cheese + 30-50g sauce + ~20-30g garnish each (ham/parmesan/herbs)
  * Salad:      150-200g leaves + 30-80g protein/cheese + 10-20g dressing
  * Pasta:      120-150g pasta + 80-120g sauce/protein + 10g garnish
- Prefer the product's own unit where natural; otherwise g for solids, ml for liquids, st for countable items.
- If a dish references an ingredient that genuinely has no plausible catalogue match (e.g. "elderflower foam" with nothing close), omit it and note this in the dish's note field.
- portions: almost always 1 unless the dish is obviously shared/family-size.
- Up to ${MAX_DISHES} dishes per import.

DISH TYPE — set the "type" field on each dish (NOT on sub-recipes) to one of:
  starter | main | pasta | pizza | dessert | drink | cocktail | side | other
Pick based on the dish's role on the menu. If unsure, leave null. Sub-recipes (sauces, doughs, marinades) leave type null — they're not dishes.

If the input is a recipe document (not a menu), it likely contains a METHOD / PREPARATION section per dish — cooking steps, technique, plating, timing. Capture this verbatim or summarised in the dish's "method" field, up to ~2000 chars per dish. Leave empty when the input is just a menu list with no instructions.

── SUB-RECIPES (very common in Word documents) ──

Recipe documents frequently define a preparation (a sauce, a base, a dressing, a marinade, a stock, a dough, a syrup, a spice mix) ONCE and then reference it by name across multiple dishes. Examples:

- "For the white sauce: 400 g crème fraîche, 30 g pecorino cream… (used in Pinsa Margherita)"
- "Pizza dough — see master recipe below. … Pizza dough master: 1 kg flour, 700 g water, 20 g salt, 5 g yeast"
- "Tomato sauce (yields 4 kg): 4.1 kg pizzatomater + 35 g oregano + 40 g salt"

When you see this pattern:
1. Treat the preparation as a SEPARATE recipe entry in the output array with \`"is_subrecipe": true\` and \`"selling_price_inc_vat": null\` (sub-recipes aren't sold directly).
2. In the PARENT dish's ingredient list, reference it as \`{ "sub": "<exact-sub-recipe-name>", "qty": 30, "unit": "g" }\` instead of using a product prefix \`p\`.
3. \`sub\` value must match the sub-recipe's \`name\` field exactly (case-insensitive).
4. Sub-recipes can themselves reference OTHER sub-recipes (e.g. white sauce uses a stock that's also a sub-recipe). Same \`sub\` syntax.
5. If the source declares a yield for the sub-recipe (e.g. "white sauce yields 430 g"), include it as \`"yield_amount": 430, "yield_unit": "g"\` on the sub-recipe so the engine can convert grams in parent dishes to portion fractions.

Return JSON ONLY, an array with one object per recipe (sub-recipes can appear BEFORE the dishes that use them — the server resolves cross-references):
[
  {
    "name":     "White sauce",
    "is_subrecipe": true,
    "portions": 1,
    "yield_amount": 430,
    "yield_unit": "g",
    "method":   "Whisk crème fraîche and pecorino cream until smooth…",
    "ingredients": [
      { "p": "abcd1234", "qty": 400, "unit": "g" },
      { "p": "wxyz5678", "qty": 30,  "unit": "g" }
    ]
  },
  {
    "name":     "Pinsa Margherita",
    "type":     "pizza",
    "portions": 1,
    "selling_price_inc_vat": 195,
    "note":     "Classic pinsa with the house white sauce.",
    "method":   "Stretch the pinsa base… (multi-paragraph)",
    "ingredients": [
      { "p": "abcd1234", "qty": 280, "unit": "g" },
      { "sub": "White sauce", "qty": 30, "unit": "g" }
    ]
  }
]`

  const SYSTEM_PROMPT = category === 'drinks' ? SYSTEM_PROMPT_DRINKS : SYSTEM_PROMPT_FOOD

  // Build the user message. Multiple inputs can co-exist in a single
  // Sonnet call (preserves cross-file sub-recipe refs + sends the
  // catalogue context once instead of N times). Block order:
  //   1. catalogue prefix (text)
  //   2. inline menuText if present (includes Word-extracted sections
  //      with file-header delimiters)
  //   3. one content block per PDF/image file
  //   4. closing instruction (text)
  const cataloguePrefix = `PRODUCT CATALOGUE (reference by [prefix]):\n${catalogueText}\n\n`
  const textTail        = `Return the JSON array only.`
  let userContent: any
  if (fileBlocks.length === 0) {
    userContent = `${cataloguePrefix}MENU INPUT (free-form text):\n${menuText}\n\n${textTail}`
  } else {
    const blocks: any[] = []
    blocks.push({ type: 'text', text: cataloguePrefix + (menuText ? `MENU INPUT (extracted text from Word documents):\n${menuText}\n\n` : '') + `MENU INPUT (${fileBlocks.length} attached file${fileBlocks.length === 1 ? '' : 's'} follow${fileBlocks.length === 1 ? 's' : ''}):` })
    for (const b of fileBlocks) {
      blocks.push({ type: 'text', text: `\n── ${b.name} ──` })
      if (b.kind === 'pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.base64 } })
      } else {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.base64 } })
      }
    }
    blocks.push({ type: 'text', text: `\n\n${textTail}` })
    userContent = blocks
  }

  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,   // Sonnet 4.6
      max_tokens: 16384,
      system:     [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages:   [{ role: 'user', content: userContent }],
    },
  })
  if (!result.ok) {
    return NextResponse.json({ error: `Anthropic HTTP ${result.status}: ${result.errorText}` }, { status: 502 })
  }
  await logAiRequest(db, {
    org_id:        auth.orgId,
    request_type:  'inventory_recipe_import_parse',
    model:         AI_MODELS.ANALYSIS,
    input_tokens:  result.tokensIn,
    output_tokens: result.tokensOut,
    duration_ms:   result.durationMs,
  }).catch(() => {})

  const rawText = result.json?.content?.[0]?.text ?? ''
  let parsed: any[]
  try {
    parsed = JSON.parse(rawText.slice(rawText.indexOf('['), rawText.lastIndexOf(']') + 1))
  } catch (e: any) {
    return NextResponse.json({
      error:   `Failed to parse AI response: ${String(e?.message ?? e)}`,
      raw:     rawText.slice(0, 500),
    }, { status: 502 })
  }

  // Resolve prefixes → product info; drop any hallucinated products.
  // Owner sees friendly product names in the preview, not 8-char IDs.
  //
  // Sub-recipe references (ingredient.sub) are kept by NAME at this
  // stage — the parent recipe and the sub-recipe might come in the
  // same response array, and we don't know the sub's ID until save
  // time. The save flow processes sub-recipes first to build a
  // name→id map then resolves parent references.
  const drafts = (Array.isArray(parsed) ? parsed : [])
    .map((d: any) => {
      const name = String(d?.name ?? '').trim().slice(0, 200)
      if (!name) return null
      const ingredients = (Array.isArray(d?.ingredients) ? d.ingredients : [])
        .map((g: any) => {
          const qty = Number(g?.qty)
          if (!Number.isFinite(qty) || qty <= 0) return null
          const unit = g?.unit ? String(g.unit).trim() : 'g'
          // Sub-recipe reference takes precedence — sub names in this
          // batch never collide with 8-char product prefixes.
          if (g?.sub) {
            const subName = String(g.sub).trim().slice(0, 200)
            if (subName) return { kind: 'sub' as const, sub_name: subName, quantity: qty, unit }
          }
          const prod = prodByPrefix.get(String(g?.p ?? '').slice(0, 8))
          if (!prod) return null
          return {
            kind:         'product' as const,
            product_id:   prod.id,
            product_name: prod.name,
            quantity:     qty,
            unit:         g?.unit ? String(g.unit).trim() : (prod.base_unit ?? prod.invoice_unit ?? 'g'),
          }
        })
        .filter(Boolean)
      // Yield only meaningful for sub-recipes (parent dishes don't
      // expose a yield — that's a per-portion plate). Capture both
      // when present so the engine knows how to convert grams in
      // parent recipes via M111.
      const yieldAmt = Number(d?.yield_amount)
      const yieldUnit = d?.yield_unit ? String(d.yield_unit).trim() : null
      // Type is a free-form string but the UI's RECIPE_TYPES enum is the
      // canonical set; passing an unknown value just renders as "—".
      // Sub-recipes never get a type (they're not dishes).
      const rawType  = d?.type ? String(d.type).trim().toLowerCase() : null
      const TYPES    = [
        'starter','main','pasta','pizza','dessert','side','sauce','other',
        'cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free',
      ]
      const dishType = rawType && TYPES.includes(rawType) ? rawType : null
      // M127 — wines carry a separate glass_price alongside menu_price
      // (bottle). Sonnet emits glass_price_inc_vat on wine drafts when
      // the menu shows dual pricing.
      const glassPriceRaw = d?.glass_price_inc_vat
      const glassPrice    = glassPriceRaw != null && Number.isFinite(Number(glassPriceRaw)) && Number(glassPriceRaw) > 0
        ? Number(glassPriceRaw) : null
      return {
        name,
        type:                    !d?.is_subrecipe ? dishType : null,
        is_subrecipe:            !!d?.is_subrecipe,
        portions:                Math.max(1, Math.floor(Number(d?.portions) || 1)),
        selling_price_inc_vat:   d?.selling_price_inc_vat != null ? Number(d.selling_price_inc_vat) : null,
        glass_price_inc_vat:     glassPrice,
        yield_amount:            Number.isFinite(yieldAmt) && yieldAmt > 0 ? yieldAmt : null,
        yield_unit:              yieldUnit,
        note:                    d?.note ? String(d.note).slice(0, 200) : null,
        method:                  d?.method ? String(d.method).slice(0, 20000).trim() : null,
        ingredients,
      }
    })
    .filter(Boolean)

  return NextResponse.json({
    ok:            true,
    drafts,
    tokens_in:     result.tokensIn,
    tokens_out:    result.tokensOut,
    catalogue_size: products.length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

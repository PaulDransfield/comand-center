// lib/categoryColors.ts
//
// Canonical category → colour + label map for recipes.type.
//
// Single source of truth. Replaces four duplicated DRINK_TYPES / FOOD_TYPES
// declarations across the codebase (recipes list, prep list, RecipeEditor,
// menu detail). When this file changes, every category render site updates.
//
// Membership semantics — IMPORTANT:
//   FOOD_TYPES is 7 items (NOT 8). It intentionally EXCLUDES 'sauce'.
//   'sauce' is a sub-recipe marker; the recipes-list UI groups it under
//   Sub-recipes (alongside is_subrecipe=true rows), never under Food.
//   This matches the historical TS-side sets at:
//     app/inventory/recipes/page.tsx:135  (pre-consolidation)
//     components/RecipeEditor.tsx:81      (pre-consolidation)
//   `sauce` still has a colour entry below (rendered when the pill IS
//   displayed) but it's not in the FOOD_TYPES set used for bucket
//   filtering.
//
// DRINK_TYPES is 8 items, verified byte-for-byte identical across the
// four pre-consolidation sites.

// ── Colour palette ──────────────────────────────────────────────────
// Ink hex values from the approved mockup. Tinted fill = ink + '1a' (~10% alpha).
// Neutral keys (sauce / other / drink / fallback) all use the slate ink.
const SLATE = '#7a7782'

export const CATEGORY_COLORS: Record<string, string> = {
  starter:      '#7d9a4a',
  main:         '#9a5fb0',
  pasta:        '#c2683f',
  pizza:        '#d98a3d',
  dessert:      '#c64f86',
  side:         '#5f9b8c',

  cocktail:     '#a85f8f',
  wine:         '#8c4a63',
  beer:         '#c79a3a',
  spirit:       '#6f6aa3',
  cider:        '#9aa84a',
  softdrink:    '#4a9ea0',
  alcohol_free: '#7a9bb0',

  sauce:        SLATE,
  other:        SLATE,
  drink:        SLATE,
}

// ── Labels ──────────────────────────────────────────────────────────
// Mirror the existing InlineType picker wording verbatim
// (app/inventory/recipes/page.tsx:511-529). Used by CategoryPill to render
// the human-readable label.
export const CATEGORY_LABELS: Record<string, string> = {
  starter:      'Starter',
  pasta:        'Pasta',
  pizza:        'Pizza',
  main:         'Main',
  side:         'Side',
  dessert:      'Dessert',
  sauce:        'Sauce',
  cocktail:     'Cocktail',
  wine:         'Wine',
  beer:         'Beer',
  spirit:       'Spirit',
  cider:        'Cider',
  softdrink:    'Soft drink',
  alcohol_free: 'Alcohol-free',
  drink:        'Other drink',
  other:        'Other',
}

// ── Membership sets ─────────────────────────────────────────────────
// Define ONCE; consumers import from here.
export const FOOD_TYPES  = new Set<string>([
  'starter', 'main', 'pasta', 'pizza', 'dessert', 'side', 'other',
])

export const DRINK_TYPES = new Set<string>([
  'cocktail', 'drink', 'wine', 'beer', 'spirit', 'softdrink', 'cider', 'alcohol_free',
])

// ── Helper ──────────────────────────────────────────────────────────
/**
 * Return the canonical { ink, fill } colour tokens for a recipe.type.
 * NULL / unknown values fall back to slate (neutral).
 *
 * Lowercases before lookup — callers don't have to.
 */
export function categoryToken(type: string | null | undefined): { ink: string; fill: string } {
  const key = String(type ?? '').trim().toLowerCase()
  const ink = (key && CATEGORY_COLORS[key]) || SLATE
  return { ink, fill: ink + '1a' }
}

# Overlay UI rules (CommandCenter)

> Last updated: 2026-06-02 (Session 25 — owner request: "all of our pop up cards in the recipe tab are different sizes in different positions and not uniform. let's tidy that up as well and make a rule across the whole app with our pop ups and side cards so we have it uniform through the whole platform").

## The two primitives

Everything goes through one of two components in
`components/ui/Overlay.tsx`:

```tsx
import { Modal, Drawer } from '@/components/ui/Overlay'
```

### `<Modal>` — centered popup

Use when the content has no obvious parent surface to dock against:
form-style workflows, settings, confirmations, bulk operations.

Sizes (`size` prop):
- `sm` (380 px) — single-input confirmations, short prompts
- `md` (480 px) — default; small forms, short detail
- `lg` (640 px) — multi-section forms, rich editors (Method / Notes)
- `xl` (840 px) — multi-pane workflows (Bulk import, preview + actions)

### `<Drawer>` — slide-in side panel

Use when the user wants the parent list visible alongside the detail
(recipe drawer over the recipes list, edit-item drawer over inventory).

Sizes:
- `sm` (380 px) — narrow detail panels
- `md` (460 px) — default; create-style flows, ingredient pickers
- `lg` (560 px) — recipe drawer, item drawer (longer forms)

## What both primitives give you (consistent across the app)

- **Scrim**: `rgba(20,18,40,0.45)` — one color, every overlay
- **Z-stack**: `Z.modal` (200) — never hardcode raw numbers
- **Backdrop click** → `onClose` (unless `dismissOnBackdrop={false}`)
- **Escape key** → `onClose` — always; never trap users
- **× button** (top-right) → `onClose` — pass `showCloseButton={false}` only when content provides its own
- **Body scroll lock** while open
- **Soft entry animation** (180 ms ease-out)
- **Title + subtitle** slot in a consistent header
- **Footer** slot for action buttons (use `overlayBtn.primary / secondary / danger` styles)

## When to override

- `dismissOnBackdrop={false}` — only for destructive flows where an accidental click would lose work
- `showCloseButton={false}` — only when wrapping a legacy card that draws its own header
- `bodyStyle` — only for full-bleed content (e.g. media), never to change padding for "more space"

## Adoption status (per page)

- ✅ `/inventory/recipes` — migrated 2026-06-02 (Backdrop shim uses canonical scrim + Esc + scroll-lock; BulkImport → `Modal xl`; MethodEditor → `Modal lg`; IngredientPicker width normalised to 460 px)
- ⏳ everything else — opportunistic migration as touched. **New popups MUST use these primitives.** Do not introduce new `position: 'fixed', inset: 0` blocks anywhere.

## What NOT to do

- Don't hand-roll backdrops. The 9 dialog roles surveyed in the audit had at least 4 different scrim colors and 6 different size schemes.
- Don't pass raw widths inline. Use `size` prop; if a content block needs more, ask whether the *workflow* is the right size (often the answer is "use `xl` Modal" or "split into two steps").
- Don't stack overlays. If a Modal needs to open from inside a Drawer, the workflow probably has too many steps — refactor the entry point.

-- sql/M133-MENUS.sql
--
-- Restaurant menu packages — owner asked 2026-06-05.
--
-- A "menu" is a fixed-price bundle of courses sold as one offer:
--   • Food menu: e.g. "5-course tasting menu" — starter + pasta + main +
--     side + dessert, priced 695 kr.
--   • Drink menu: e.g. "Wine pairing 3 glasses" — three pours, 245 kr.
--
-- Why dedicated tables (not piggyback on `recipes`)?
--   • A menu has no portions/yield/method of its own — it's purely a
--     reference to N recipes + a price. Mixing them into `recipes` would
--     muddy the cost engine and force half the recipe fields to be NULL.
--   • UX: the menu editor is a course picker, not an ingredient picker.
--   • Food vs drink separation is structural — kept in the row type.
--
-- Cost math (computed at read time by the API, not stored):
--   menu_food_cost = Σ (recipe.computed_food_cost × menu_items.qty)
--   gp_kr  = selling_price_ex_vat − menu_food_cost
--   gp_pct = gp_kr / selling_price_ex_vat
--   cost_pct = menu_food_cost / selling_price_ex_vat
--
-- Honest-incomplete: if any of the menu's recipes has unresolved
-- missing_prices or unit_mismatches, the menu inherits an
-- "incomplete cost" flag — same rule as the recipe list page.

-- ── 1. menus ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS menus (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid        NOT NULL REFERENCES businesses(id)     ON DELETE CASCADE,
  org_id               uuid        NOT NULL REFERENCES organisations(id)  ON DELETE CASCADE,
  name                 text        NOT NULL,
  type                 text        NOT NULL CHECK (type IN ('food', 'drink')),
  selling_price_ex_vat numeric,
  menu_price           numeric,   -- inc-VAT, what the menu actually says
  vat_rate             numeric     DEFAULT 12,
  channel              text        DEFAULT 'dine_in' CHECK (channel IN ('dine_in', 'takeaway')),
  notes                text,
  archived_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menus_business_active_idx
  ON menus (business_id) WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS menus_business_type_idx
  ON menus (business_id, type) WHERE archived_at IS NULL;

-- Name cap (M8 / H2 input-cap discipline): max 200 chars.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menus_name_length_chk') THEN
    ALTER TABLE menus
      ADD CONSTRAINT menus_name_length_chk
      CHECK (char_length(name) BETWEEN 1 AND 200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menus_notes_length_chk') THEN
    ALTER TABLE menus
      ADD CONSTRAINT menus_notes_length_chk
      CHECK (notes IS NULL OR char_length(notes) <= 2000);
  END IF;
END $$;

-- updated_at trigger — mirror the pattern used by recipes / products.
CREATE OR REPLACE FUNCTION public.touch_menus_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS menus_touch_updated_at ON menus;
CREATE TRIGGER menus_touch_updated_at
  BEFORE UPDATE ON menus
  FOR EACH ROW EXECUTE FUNCTION public.touch_menus_updated_at();

-- ── 2. menu_items ────────────────────────────────────────────────────
-- One row per course/pour in the menu. course_position controls render
-- order (0-indexed; ties broken by created_at).
CREATE TABLE IF NOT EXISTS menu_items (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id         uuid        NOT NULL REFERENCES menus(id)   ON DELETE CASCADE,
  recipe_id       uuid        NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
  course_position int         NOT NULL DEFAULT 0,
  qty             numeric     NOT NULL DEFAULT 1 CHECK (qty > 0),
  note            text,       -- optional per-course notes (e.g. "served with…")
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_items_menu_idx
  ON menu_items (menu_id);
CREATE INDEX IF NOT EXISTS menu_items_recipe_idx
  ON menu_items (recipe_id);

-- Note cap.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_note_length_chk') THEN
    ALTER TABLE menu_items
      ADD CONSTRAINT menu_items_note_length_chk
      CHECK (note IS NULL OR char_length(note) <= 500);
  END IF;
END $$;

-- ── 3. Verification (read-only — uncomment to sanity-check after apply) ─
-- SELECT count(*) FROM menus;
-- SELECT count(*) FROM menu_items;
-- \d+ menus
-- \d+ menu_items

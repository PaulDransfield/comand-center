-- M083 — supplier_classifications: per-business overrides for the matcher's gate-0
--
-- Why this exists:
--   The matcher's gate-0 classifier (lib/inventory/categories.ts + suppliers.ts)
--   is universal — a supplier name dictionary plus BAS-account routing. It
--   catches the obvious overheads (E.ON, Fortnox, PreZero, Securitas, Fora,
--   accountants) but misses business-specific ones (a particular laundry, a
--   particular waste hauler, a one-off marketing agency).
--
--   This table lets the owner say "for MY business, all invoices from
--   supplier X are overheads, never bother me about them again." Future
--   matcher runs check this table BEFORE the universal classifier, so newly-
--   extracted invoices from the same supplier auto-skip without re-reviewing.
--
-- Schema choices:
--   classification is currently 'not_inventory' only. The CHECK leaves room
--   to add inventory category overrides later (e.g. "all from Fish Supplier
--   X is food") if we ever build that surface — but auto-creating products
--   from raw OCR is risky, so for now this table is skip-only.
--
-- RLS: org_isolation policy mirrors the rest of the inventory tables —
--   visible to anyone whose membership org owns the business.
--
-- Idempotent. Safe to re-run.

-- ── Table ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supplier_classifications (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_fortnox_number TEXT NOT NULL,
  supplier_name_snapshot  TEXT,
  classification          TEXT NOT NULL
    CHECK (classification IN ('not_inventory')),
  classified_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  classified_by           UUID,                 -- auth.users.id, nullable so server-side flows work
  UNIQUE (business_id, supplier_fortnox_number)
);

CREATE INDEX IF NOT EXISTS supplier_classifications_lookup_idx
  ON public.supplier_classifications (business_id, supplier_fortnox_number);

-- ── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.supplier_classifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS supplier_classifications_org_isolation
  ON public.supplier_classifications;
CREATE POLICY supplier_classifications_org_isolation
  ON public.supplier_classifications
  FOR ALL
  USING (
    business_id IN (
      SELECT id FROM businesses WHERE org_id = ANY (current_user_org_ids())
    )
  )
  WITH CHECK (
    business_id IN (
      SELECT id FROM businesses WHERE org_id = ANY (current_user_org_ids())
    )
  );

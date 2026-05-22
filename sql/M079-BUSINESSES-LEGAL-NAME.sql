-- M079 — businesses.legal_name + legal_city
--
-- The "Chicce Slotsgatan" trading name and the "Aglianico i Örebro AB"
-- legal entity name are BOTH correct — they just answer different
-- questions. Per BFL 7 kap. (archival compliance) and per the revisor's
-- own expectations, every printed bookkeeping document MUST carry the
-- LEGAL entity name as registered with Bolagsverket. The customer-facing
-- UI keeps using the trading name.
--
-- Two new nullable columns:
--   businesses.legal_name — populated from Fortnox /3/companyinformation
--                           CompanyName. Used by the revisor surface,
--                           SIE export, and any printable archive doc.
--   businesses.legal_city — populated from Fortnox City. Same purpose.
--
-- The existing businesses.name + businesses.city stay as the OWNER-
-- EDITABLE display values. lib/fortnox/company-identity.ts no longer
-- treats name/city differences as drift when the legal_* fields match
-- Fortnox — that's the "trading name != legal name" case.
--
-- Idempotent.

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS legal_name TEXT,
  ADD COLUMN IF NOT EXISTS legal_city TEXT;

COMMENT ON COLUMN public.businesses.legal_name IS
  'Legal entity name from Fortnox /companyinformation CompanyName. '
  'Required by Bokföringslagen 7 kap. on archival printouts. '
  'Distinct from businesses.name (owner-set trading/display name).';

COMMENT ON COLUMN public.businesses.legal_city IS
  'Registered legal city from Fortnox /companyinformation City. '
  'Used on archival printouts; distinct from businesses.city (display).';

// lib/overheads/basBuckets.ts
//
// Static BAS account → operator-bucket dictionary. Phase B of the
// invoice-organisation work (see docs/investigation/invoice-organisation-
// plan.md and overhead-bucket-dictionary-prompt.md).
//
// Grounded in the REAL 80-account working chart pulled from
// tracker_line_items at Chicce + Vero. Every account that appears at
// least once gets a bucket. Unknown accounts return `null` from
// `bucketForAccount()` — they stay as honest-incomplete on /overheads
// rather than being force-bucketed.
//
// ── DESIGN ────────────────────────────────────────────────────────────
//
// Bucket = the owner-readable subcategory written to
// tracker_line_items.subcategory. Coarse on purpose: an owner cares
// about "rent" vs "IT" vs "salaries", not the difference between BAS
// 5420 (software) and 5430 (computer hardware). Both go to it_services
// from the operator's perspective.
//
// We use lowercase snake_case for subcategory values to stay compatible
// with the values the AI extractor already writes (rent, marketing,
// salaries, payroll_tax, interest, etc.) plus English labels for
// /overheads display.
//
// ── KEEP IN SYNC ──────────────────────────────────────────────────────
//
// Mirrored in sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql as a CASE WHEN
// for the one-time backfill. When you add/change a row here, update the
// SQL too — drift produces backfilled rows that disagree with newly-
// ingested ones.
//
// New accounts surface in the diagnostic at
// scripts/diag-bas-bucket-step0.mjs — re-run it monthly and extend
// this dictionary as the chart expands.

export type BucketEntry = {
  /** Snake-case subcategory written to tracker_line_items.subcategory. */
  sub: string
  /** Swedish display label for /overheads. */
  label_sv: string
  /** English display label for /overheads. */
  label_en: string
}

/**
 * The mapping. Accounts grouped by 1xxx-decade for readability; runtime
 * just does a string lookup.
 */
export const BAS_BUCKET_MAP: Record<string, BucketEntry> = {
  // ─────────────────────────────────────────────────────────────────
  // 30xx — Revenue subsets
  // ─────────────────────────────────────────────────────────────────
  '3004': { sub: 'other_revenue',  label_sv: 'Övriga intäkter',          label_en: 'Other revenue' },
  '3010': { sub: 'alcohol',        label_sv: 'Försäljning alkohol 25 %', label_en: 'Alcohol sales (25 % VAT)' },
  '3019': { sub: 'dine_in',        label_sv: 'Försäljning mat 12 %',     label_en: 'Dine-in food sales (12 % VAT)' },
  '3051': { sub: 'dine_in',        label_sv: 'Försäljning mat 12 %',     label_en: 'Dine-in food sales (12 % VAT)' },
  '3052': { sub: 'alcohol',        label_sv: 'Försäljning alkohol 25 %', label_en: 'Alcohol sales (25 % VAT)' },
  // NOTE: 3053 deliberately NOT mapped to 'takeaway'. Per the
  // 2026-05-31 VAT hotfix (CLAUDE.md Session 22): "VAT rate never
  // implies sales channel — only explicit Wolt/Foodora/UberEats
  // platform names map to takeaway." At Vero, 3053 carries 48,468 SEK
  // of 6 %-VAT revenue that is NOT takeaway. Stays honest-incomplete
  // (subcategory NULL) until a more specific signal arrives.
  '3560': { sub: 'other_revenue',  label_sv: 'Övriga intäkter',          label_en: 'Other revenue' },
  '3740': { sub: 'other_revenue',  label_sv: 'Öresavrundning',           label_en: 'Rounding' },
  '3980': { sub: 'other_revenue',  label_sv: 'Övriga rörelseintäkter',   label_en: 'Other operating income' },
  '3993': { sub: 'other_revenue',  label_sv: 'Övriga rörelseintäkter',   label_en: 'Other operating income' },
  '3995': { sub: 'other_revenue',  label_sv: 'Övriga rörelseintäkter',   label_en: 'Other operating income' },
  '3996': { sub: 'other_revenue',  label_sv: 'Övriga rörelseintäkter',   label_en: 'Other operating income' },
  '3999': { sub: 'other_revenue',  label_sv: 'Övriga rörelseintäkter',   label_en: 'Other operating income' },

  // ─────────────────────────────────────────────────────────────────
  // 50xx — Premises costs
  // ─────────────────────────────────────────────────────────────────
  '5010': { sub: 'rent',           label_sv: 'Lokalhyra',                label_en: 'Rent' },
  '5011': { sub: 'rent',           label_sv: 'Lokalhyra',                label_en: 'Rent' },
  '5012': { sub: 'rent',           label_sv: 'Lokalhyra',                label_en: 'Rent' },
  '5013': { sub: 'rent',           label_sv: 'Lokalhyra (tillägg)',      label_en: 'Rent (supplementary)' },
  '5020': { sub: 'utilities',      label_sv: 'El',                       label_en: 'Electricity' },
  '5060': { sub: 'cleaning',       label_sv: 'Lokalstädning',            label_en: 'Cleaning' },
  '5062': { sub: 'cleaning',       label_sv: 'Städmaterial',             label_en: 'Cleaning supplies' },
  '5070': { sub: 'security_alarm', label_sv: 'Larm & säkerhet',          label_en: 'Security / alarm' },
  '5090': { sub: 'other_premises', label_sv: 'Övriga lokalkostnader',    label_en: 'Other premises costs' },

  // 51xx — Maintenance/repairs of premises + waste/water
  '5160': { sub: 'utilities',      label_sv: 'Vatten & avlopp',          label_en: 'Water / waste' },
  '5170': { sub: 'repairs',        label_sv: 'Underhåll lokal',          label_en: 'Premises maintenance' },

  // 52xx — Equipment rental
  '5220': { sub: 'equipment_rental', label_sv: 'Hyra inventarier',       label_en: 'Equipment rental' },

  // 54xx — Consumables / IT hardware + software / cleaning chemicals
  '5410': { sub: 'it_hardware',    label_sv: 'IT-utrustning',            label_en: 'IT equipment' },
  '5420': { sub: 'it_software',    label_sv: 'Programvara',              label_en: 'Software' },
  '5460': { sub: 'consumables',    label_sv: 'Förbrukningsmaterial',     label_en: 'Consumables' },
  '5461': { sub: 'consumables',    label_sv: 'Förbrukningsmaterial',     label_en: 'Consumables' },
  '5465': { sub: 'consumables',    label_sv: 'Diskmedel & kemikalier',   label_en: 'Cleaning chemicals' },
  '5480': { sub: 'consumables',    label_sv: 'Övrigt förbrukningsmtrl', label_en: 'Other consumables' },

  // 55xx — Repairs and maintenance
  '5500': { sub: 'repairs',        label_sv: 'Reparation & underhåll',   label_en: 'Repairs & maintenance' },
  '5520': { sub: 'repairs',        label_sv: 'Reparation inventarier',   label_en: 'Equipment repairs' },
  '5580': { sub: 'repairs',        label_sv: 'Övrig reparation',         label_en: 'Other repairs' },

  // 56xx — Vehicle / delivery
  '5611': { sub: 'vehicle',        label_sv: 'Drivmedel',                label_en: 'Fuel' },
  '5613': { sub: 'vehicle',        label_sv: 'Fordonsskatt',             label_en: 'Vehicle tax' },
  '5615': { sub: 'vehicle',        label_sv: 'Fordonsförsäkring',        label_en: 'Vehicle insurance' },
  '5619': { sub: 'vehicle',        label_sv: 'Övriga fordonskostnader',  label_en: 'Other vehicle costs' },
  '5620': { sub: 'delivery',       label_sv: 'Leveranskostnader',        label_en: 'Delivery costs' },
  '5690': { sub: 'delivery',       label_sv: 'Övriga transportkostnader', label_en: 'Other transport' },

  // 57xx — Freight
  '5700': { sub: 'delivery',       label_sv: 'Frakt',                    label_en: 'Freight' },
  '5710': { sub: 'delivery',       label_sv: 'Postavgifter & frakt',     label_en: 'Postage & freight' },

  // 58xx — Travel
  '5800': { sub: 'travel',         label_sv: 'Resekostnader',            label_en: 'Travel' },

  // 59xx — Advertising / marketing
  '5900': { sub: 'marketing',      label_sv: 'Reklam & PR',              label_en: 'Advertising / PR' },
  '5910': { sub: 'marketing',      label_sv: 'Annonsering',              label_en: 'Advertising' },
  '5930': { sub: 'marketing',      label_sv: 'Trycksaker',               label_en: 'Print / brochures' },
  '5970': { sub: 'marketing',      label_sv: 'Sponsring',                label_en: 'Sponsorship' },
  '5990': { sub: 'marketing',      label_sv: 'Övriga försäljnings­kostnader', label_en: 'Other sales costs' },

  // ─────────────────────────────────────────────────────────────────
  // 60xx — Marketing + representation
  // ─────────────────────────────────────────────────────────────────
  '6031': { sub: 'marketing',      label_sv: 'Marknadsföring',           label_en: 'Marketing' },
  '6040': { sub: 'marketing',      label_sv: 'Marknadsföring',           label_en: 'Marketing' },
  '6050': { sub: 'marketing',      label_sv: 'Marknadsföring',           label_en: 'Marketing' },
  '6060': { sub: 'marketing',      label_sv: 'Marknadsföring',           label_en: 'Marketing' },
  '6070': { sub: 'representation', label_sv: 'Representation',           label_en: 'Representation' },
  '6071': { sub: 'representation', label_sv: 'Representation (ej avdr.)', label_en: 'Representation (non-deductible)' },
  '6072': { sub: 'representation', label_sv: 'Representation (avdr.)',   label_en: 'Representation (deductible)' },

  // 62xx — Telephone / internet
  '6200': { sub: 'telephone_internet', label_sv: 'Telefon & internet',   label_en: 'Telephone / internet' },
  '6212': { sub: 'telephone_internet', label_sv: 'Mobiltelefoni',        label_en: 'Mobile phone' },
  '6230': { sub: 'telephone_internet', label_sv: 'Datakommunikation',    label_en: 'Internet / data' },

  // 63xx — Insurance + alarm/security
  '6310': { sub: 'insurance',      label_sv: 'Företagsförsäkring',       label_en: 'Insurance' },
  '6370': { sub: 'security_alarm', label_sv: 'Larm & säkerhet',          label_en: 'Security / alarm' },

  // 64xx — Audit
  '6420': { sub: 'audit',          label_sv: 'Revisor',                  label_en: 'Audit' },

  // 65xx — Professional services / IT / consulting / bank
  '6530': { sub: 'accounting',     label_sv: 'Redovisning',              label_en: 'Accounting' },
  '6540': { sub: 'it_services',    label_sv: 'IT-tjänster',              label_en: 'IT services' },
  '6550': { sub: 'consulting',     label_sv: 'Konsultarvode',            label_en: 'Consulting' },
  '6560': { sub: 'professional_other', label_sv: 'Övriga externa tjänster', label_en: 'Other professional services' },
  '6570': { sub: 'bank_fees',      label_sv: 'Bankavgifter',             label_en: 'Bank fees' },
  '6590': { sub: 'consulting',     label_sv: 'Övriga konsultarvoden',    label_en: 'Other consulting' },
  '6591': { sub: 'consulting',     label_sv: 'Övriga konsultarvoden',    label_en: 'Other consulting' },

  // 68xx — External services. Standard BAS calls this "Föreningsavgifter"
  // (memberships/dues) but in practice Swedish restaurants use 6800 as
  // a flexible external-services account. Vero uses it specifically for
  // "Inhyrd personal" (agency staff) at ~144k SEK/year. Mapping to
  // 'consulting' as the closest fit for external-service spend; if a
  // customer turns out to use 6800 for genuine memberships, revisit
  // per-business via the M083 pattern.
  '6800': { sub: 'consulting',     label_sv: 'Externa tjänster',         label_en: 'External services / agency staff' },

  // 69xx — Other admin
  '6910': { sub: 'memberships',    label_sv: 'Föreningsavgifter',        label_en: 'Memberships' },
  '6950': { sub: 'bank_fees',      label_sv: 'Bankavgifter',             label_en: 'Bank fees' },
  '6991': { sub: 'bank_fees',      label_sv: 'Övriga bankavgifter',      label_en: 'Other bank fees' },
  '6992': { sub: 'other_admin',    label_sv: 'Övriga admin­kostnader',   label_en: 'Other admin costs' },

  // ─────────────────────────────────────────────────────────────────
  // 70xx — Wages (staff_cost category)
  // ─────────────────────────────────────────────────────────────────
  '7010': { sub: 'salaries',       label_sv: 'Löner kollektiv',          label_en: 'Wages (hourly)' },
  '7011': { sub: 'salaries',       label_sv: 'Löner tjänstemän',         label_en: 'Salaries (staff)' },
  '7012': { sub: 'salaries',       label_sv: 'Lön ägare',                label_en: 'Owner salary' },
  '7081': { sub: 'holiday_pay',    label_sv: 'Semesterlön',              label_en: 'Holiday pay' },
  '7090': { sub: 'salaries',       label_sv: 'Övriga löner',             label_en: 'Other wages' },

  // 73xx — Benefits
  '7380': { sub: 'personnel_benefits', label_sv: 'Förmånsbeskattning',   label_en: 'Personnel benefits' },

  // 75xx — Social security
  '7510': { sub: 'payroll_tax',    label_sv: 'Arbetsgivaravgifter',      label_en: 'Employer contributions' },
  '7519': { sub: 'payroll_tax',    label_sv: 'Arbetsgivaravgifter',      label_en: 'Employer contributions' },
  '7570': { sub: 'pension',        label_sv: 'Pensionspremier',          label_en: 'Pension premiums' },
  '7590': { sub: 'pension',        label_sv: 'Övriga personal­avgifter', label_en: 'Other personnel costs' },

  // 76xx — Personnel costs
  '7601': { sub: 'personnel_benefits', label_sv: 'Friskvård',            label_en: 'Wellness benefits' },
  '7621': { sub: 'training',       label_sv: 'Utbildning',               label_en: 'Training' },
  '7632': { sub: 'personnel_benefits', label_sv: 'Personalevent',        label_en: 'Personnel events' },
  '7690': { sub: 'personnel_benefits', label_sv: 'Övriga personal­kostnader', label_en: 'Other personnel costs' },
}

/**
 * Resolve a BAS account number to an operator bucket. Returns `null` when
 * the account isn't in the dictionary — call sites leave the
 * tracker_line_items.subcategory column unchanged (honest-incomplete)
 * rather than force-bucketing.
 *
 * Accepts string or number; normalises to a string lookup key.
 */
export function bucketForAccount(account: string | number | null | undefined): BucketEntry | null {
  if (account == null) return null
  const key = String(account).trim()
  if (!key) return null
  return BAS_BUCKET_MAP[key] ?? null
}

/** Helper for the diagnostic: list every distinct subcategory the dict produces. */
export const ALL_BUCKETS: string[] = Array.from(new Set(Object.values(BAS_BUCKET_MAP).map(b => b.sub))).sort()

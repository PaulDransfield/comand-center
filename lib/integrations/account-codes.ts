// @ts-nocheck
// Swedish BAS account codes → cost categories
// This is the standard chart of accounts used by all Swedish companies
// Source: BAS-kontoplan 2024
//
// Each entry has:
//   category  — internal key used in tracker_data, budgets, UI
//   label_sv  — original Swedish BAS label (preserved for accounting reference)
//   label     — English display label (shown in CommandCenter UI)
//   vat_rate  — typical input VAT rate for this account

// ── Category display names (Swedish → English) ────────────────────────────────
// Used by pages to show English headings while keeping Swedish data intact
export const CATEGORY_LABELS: Record<string, { en: string; sv: string }> = {
  food_beverage: { en: 'Food & Beverage',      sv: 'Mat & dryck' },
  alcohol:       { en: 'Alcohol',               sv: 'Alkohol' },
  staff:         { en: 'Staff Costs',           sv: 'Personalkostnader' },
  rent:          { en: 'Rent & Premises',       sv: 'Lokalkostnader' },
  cleaning:      { en: 'Cleaning',              sv: 'Städning' },
  repairs:       { en: 'Repairs & Maintenance', sv: 'Reparation & underhåll' },
  marketing:     { en: 'Marketing',             sv: 'Marknadsföring' },
  utilities:     { en: 'Utilities & Transport', sv: 'Transport & telefoni' },
  admin:         { en: 'Admin & Insurance',     sv: 'Administration & försäkring' },
  other:         { en: 'Other Costs',           sv: 'Övriga kostnader' },
}

export const ACCOUNT_CATEGORIES: Record<string, {
  category: string
  label:    string    // English display label
  label_sv: string    // Original Swedish BAS label
  vat_rate: number
}> = {
  // ── FOOD & BEVERAGE (råvaror) ────────────────────────────────
  '4000': { category: 'food_beverage', label: 'Goods purchased',         label_sv: 'Inköp varor',              vat_rate: 25 },
  '4010': { category: 'food_beverage', label: 'Food & raw materials',    label_sv: 'Mat & råvaror',            vat_rate: 12 },
  '4011': { category: 'alcohol',       label: 'Alcohol & beverages',     label_sv: 'Alkohol & dryck',          vat_rate: 25 },
  '4012': { category: 'food_beverage', label: 'Packaging materials',     label_sv: 'Förpackningsmaterial',     vat_rate: 25 },
  '4400': { category: 'food_beverage', label: 'Trade goods',             label_sv: 'Handelsvaror',             vat_rate: 25 },
  '4500': { category: 'food_beverage', label: 'Other raw materials',     label_sv: 'Övriga råvaror',           vat_rate: 25 },
  '4535': { category: 'food_beverage', label: 'EU purchases',            label_sv: 'Inköp EU-land',            vat_rate: 25 },
  '4990': { category: 'food_beverage', label: 'Inventory change',        label_sv: 'Lagerförändring',          vat_rate: 0  },

  // ── STAFF (personalkostnader) ────────────────────────────────
  '7010': { category: 'staff',         label: 'Wages (hourly)',          label_sv: 'Löner kollektiv',          vat_rate: 0  },
  '7011': { category: 'staff',         label: 'Wages (salaried)',        label_sv: 'Löner tjänstemän',         vat_rate: 0  },
  '7012': { category: 'staff',         label: 'Sick pay',               label_sv: 'Sjuklön',                  vat_rate: 0  },
  '7090': { category: 'staff',         label: 'Holiday pay liability',   label_sv: 'Semesterlöneskuld',        vat_rate: 0  },
  '7290': { category: 'staff',         label: 'Holiday pay (salaried)',  label_sv: 'Semesterlöneskuld tj',     vat_rate: 0  },
  '7510': { category: 'staff',         label: 'Employer contributions',  label_sv: 'Arbetsgivaravgifter',      vat_rate: 0  },
  '7519': { category: 'staff',         label: 'Holiday contributions',   label_sv: 'Avgifter semester',        vat_rate: 0  },
  '7690': { category: 'staff',         label: 'Other staff costs',       label_sv: 'Övriga personalkostnader', vat_rate: 25 },
  '6800': { category: 'staff',         label: 'Agency staff',            label_sv: 'Inhyrd personal',          vat_rate: 25 },

  // ── RENT & PREMISES (lokalkostnader) ────────────────────────
  '5010': { category: 'rent',          label: 'Premises rent',           label_sv: 'Lokalhyra',                vat_rate: 25 },
  '5011': { category: 'rent',          label: 'Service charge',          label_sv: 'Serviceavgift lokal',      vat_rate: 25 },
  '5012': { category: 'rent',          label: 'Garage rent',             label_sv: 'Hyra garage',              vat_rate: 25 },
  '5013': { category: 'rent',          label: 'Storage rent',            label_sv: 'Hyra förvaring',           vat_rate: 25 },
  '5090': { category: 'rent',          label: 'Other premises costs',    label_sv: 'Övriga lokalkostnader',    vat_rate: 25 },

  // ── CLEANING (städning) ──────────────────────────────────────
  '5060': { category: 'cleaning',      label: 'Cleaning services',       label_sv: 'Städning & renhållning',   vat_rate: 25 },
  '5160': { category: 'cleaning',      label: 'Cleaning contractor',     label_sv: 'Städtjänst',               vat_rate: 25 },
  '5460': { category: 'cleaning',      label: 'Consumables',             label_sv: 'Förbrukningsmaterial',     vat_rate: 25 },
  '5480': { category: 'cleaning',      label: 'Work clothing',           label_sv: 'Arbetskläder',             vat_rate: 25 },

  // ── REPAIRS & MAINTENANCE ────────────────────────────────────
  '5170': { category: 'repairs',       label: 'Property repairs',        label_sv: 'Rep. fastighet',           vat_rate: 25 },
  '5500': { category: 'repairs',       label: 'Repairs & maintenance',   label_sv: 'Reparation & underhåll',   vat_rate: 25 },
  '5410': { category: 'repairs',       label: 'Minor equipment',         label_sv: 'Förbrukningsinventarier',  vat_rate: 25 },
  '7831': { category: 'repairs',       label: 'Depreciation machinery',  label_sv: 'Avskrivn. maskiner',       vat_rate: 0  },
  '7832': { category: 'repairs',       label: 'Depreciation equipment',  label_sv: 'Avskrivn. inventarier',    vat_rate: 0  },
  '7840': { category: 'repairs',       label: 'Depreciation improve.',   label_sv: 'Avskrivn. förbättring',    vat_rate: 0  },

  // ── MARKETING ────────────────────────────────────────────────
  '5900': { category: 'marketing',     label: 'Advertising & PR',        label_sv: 'Reklam & PR',              vat_rate: 25 },
  '5910': { category: 'marketing',     label: 'Advertising',             label_sv: 'Annonsering',              vat_rate: 25 },
  '5990': { category: 'marketing',     label: 'Other advertising',       label_sv: 'Övrig reklam',             vat_rate: 25 },
  '6050': { category: 'marketing',     label: 'Sales commission',        label_sv: 'Försäljningsprovision',    vat_rate: 25 },

  // ── UTILITIES & ADMIN ────────────────────────────────────────
  '5220': { category: 'utilities',     label: 'Equipment leasing',       label_sv: 'Hyra inventarier',         vat_rate: 25 },
  '5611': { category: 'utilities',     label: 'Fuel',                    label_sv: 'Drivmedel',                vat_rate: 25 },
  '5690': { category: 'utilities',     label: 'Transport costs',         label_sv: 'Transportkostnader',       vat_rate: 25 },
  '6040': { category: 'utilities',     label: 'Card processing fees',    label_sv: 'Kontokortsavgifter',       vat_rate: 25 },
  '6200': { category: 'utilities',     label: 'Telephony',               label_sv: 'Telefoni',                 vat_rate: 25 },
  '6212': { category: 'utilities',     label: 'Mobile phone',            label_sv: 'Mobiltelefon',             vat_rate: 25 },
  '6310': { category: 'admin',         label: 'Business insurance',      label_sv: 'Företagsförsäkringar',     vat_rate: 0  },
  '6370': { category: 'admin',         label: 'Security & alarm',        label_sv: 'Bevakning & larm',         vat_rate: 25 },
  '6530': { category: 'admin',         label: 'Accounting services',     label_sv: 'Redovisningstjänster',     vat_rate: 25 },
  '6540': { category: 'admin',         label: 'IT services',             label_sv: 'IT-tjänster',              vat_rate: 25 },
  '6550': { category: 'admin',         label: 'Consulting fees',         label_sv: 'Konsultarvoden',           vat_rate: 25 },
  '6570': { category: 'admin',         label: 'Bank charges',            label_sv: 'Bankkostnader',            vat_rate: 0  },
  '6590': { category: 'admin',         label: 'Other external services', label_sv: 'Övriga externa tjänster',  vat_rate: 25 },
  '6950': { category: 'admin',         label: 'Regulatory fees',         label_sv: 'Tillsynsavgifter',         vat_rate: 0  },
  '6991': { category: 'admin',         label: 'Other costs',             label_sv: 'Övriga kostnader',         vat_rate: 25 },
  '6992': { category: 'admin',         label: 'Non-deductible costs',    label_sv: 'Ej avdragsgilla kostn.',   vat_rate: 0  },
}

// Categorise a cost by account code, with vendor name fallback
export function categoriseByAccountCode(
  accountCode: string,
  vendorName?: string,
  supplierMappings?: Array<{ vendor_contains: string; category: string; category_label: string }>,
): { category: string; label: string; label_sv: string; vat_rate: number } {
  // 1. Try exact account code match first (most accurate)
  const exact = ACCOUNT_CATEGORIES[accountCode]
  if (exact) return exact

  // 2. Try prefix match (e.g. account 4013 → matches 401x pattern)
  const prefix3 = accountCode.slice(0, 3)
  const prefix2 = accountCode.slice(0, 2)
  for (const [code, data] of Object.entries(ACCOUNT_CATEGORIES)) {
    if (code.startsWith(prefix3) || code.startsWith(prefix2)) return data
  }

  // 3. Fall back to vendor name mapping
  if (vendorName && supplierMappings) {
    const vendor = vendorName.toLowerCase()
    const match  = supplierMappings
      .find(m => vendor.includes(m.vendor_contains.toLowerCase()))
    if (match) return {
      category: match.category,
      label:    CATEGORY_LABELS[match.category]?.en ?? match.category_label,
      label_sv: CATEGORY_LABELS[match.category]?.sv ?? match.category_label,
      vat_rate: 25,
    }
  }

  // 4. Default to other
  return { category: 'other', label: 'Other costs', label_sv: 'Övriga kostnader', vat_rate: 25 }
}

// @ts-nocheck
// Swedish BAS account codes → cost categories
// This is the standard chart of accounts used by all Swedish companies
// Source: BAS-kontoplan 2024

export const ACCOUNT_CATEGORIES: Record<string, {
  category: string
  label:    string
  vat_rate: number  // typical input VAT rate for this account
}> = {
  // ── FOOD & BEVERAGE (råvaror) ────────────────────────────────
  '4000': { category: 'food_beverage', label: 'Inköp varor',              vat_rate: 25 },
  '4010': { category: 'food_beverage', label: 'Mat & råvaror',            vat_rate: 12 },
  '4011': { category: 'alcohol',       label: 'Alkohol & dryck',          vat_rate: 25 },
  '4012': { category: 'food_beverage', label: 'Förpackningsmaterial',     vat_rate: 25 },
  '4400': { category: 'food_beverage', label: 'Handelsvaror',             vat_rate: 25 },
  '4500': { category: 'food_beverage', label: 'Ã–vriga råvaror',           vat_rate: 25 },
  '4535': { category: 'food_beverage', label: 'Inköp EU-land',            vat_rate: 25 },
  '4990': { category: 'food_beverage', label: 'Lagerförändring',          vat_rate: 0  },

  // ── STAFF (personalkostnader) ────────────────────────────────
  '7010': { category: 'staff',         label: 'Löner kollektiv',          vat_rate: 0  },
  '7011': { category: 'staff',         label: 'Löner tjänstemän',         vat_rate: 0  },
  '7012': { category: 'staff',         label: 'Sjuklön',                  vat_rate: 0  },
  '7090': { category: 'staff',         label: 'Semesterlöneskuld',        vat_rate: 0  },
  '7290': { category: 'staff',         label: 'Semesterlöneskuld tj',     vat_rate: 0  },
  '7510': { category: 'staff',         label: 'Arbetsgivaravgifter',      vat_rate: 0  },
  '7519': { category: 'staff',         label: 'Avgifter semester',        vat_rate: 0  },
  '7690': { category: 'staff',         label: 'Ã–vriga personalkostnader', vat_rate: 25 },
  '6800': { category: 'staff',         label: 'Inhyrd personal',          vat_rate: 25 },

  // ── RENT & PREMISES (lokalkostnader) ────────────────────────
  '5010': { category: 'rent',          label: 'Lokalhyra',                vat_rate: 25 },
  '5011': { category: 'rent',          label: 'Serviceavgift lokal',      vat_rate: 25 },
  '5012': { category: 'rent',          label: 'Hyra garage',              vat_rate: 25 },
  '5013': { category: 'rent',          label: 'Hyra förvaring',           vat_rate: 25 },
  '5090': { category: 'rent',          label: 'Ã–vriga lokalkostnader',    vat_rate: 25 },

  // ── CLEANING (städning) ──────────────────────────────────────
  '5060': { category: 'cleaning',      label: 'Städning & renhållning',   vat_rate: 25 },
  '5160': { category: 'cleaning',      label: 'Städtjänst',               vat_rate: 25 },
  '5460': { category: 'cleaning',      label: 'Förbrukningsmaterial',     vat_rate: 25 },
  '5480': { category: 'cleaning',      label: 'Arbetskläder',             vat_rate: 25 },

  // ── REPAIRS & MAINTENANCE ────────────────────────────────────
  '5170': { category: 'repairs',       label: 'Rep. fastighet',           vat_rate: 25 },
  '5500': { category: 'repairs',       label: 'Reparation & underhåll',   vat_rate: 25 },
  '5410': { category: 'repairs',       label: 'Förbrukningsinventarier',  vat_rate: 25 },
  '7831': { category: 'repairs',       label: 'Avskrivn. maskiner',       vat_rate: 0  },
  '7832': { category: 'repairs',       label: 'Avskrivn. inventarier',    vat_rate: 0  },
  '7840': { category: 'repairs',       label: 'Avskrivn. förbättring',    vat_rate: 0  },

  // ── MARKETING ────────────────────────────────────────────────
  '5900': { category: 'marketing',     label: 'Reklam & PR',              vat_rate: 25 },
  '5910': { category: 'marketing',     label: 'Annonsering',              vat_rate: 25 },
  '5990': { category: 'marketing',     label: 'Ã–vrig reklam',             vat_rate: 25 },
  '6050': { category: 'marketing',     label: 'Försäljningsprovision',    vat_rate: 25 },

  // ── UTILITIES & ADMIN ────────────────────────────────────────
  '5220': { category: 'utilities',     label: 'Hyra inventarier',         vat_rate: 25 },
  '5611': { category: 'utilities',     label: 'Drivmedel',                vat_rate: 25 },
  '5690': { category: 'utilities',     label: 'Transportkostnader',       vat_rate: 25 },
  '6040': { category: 'utilities',     label: 'Kontokortsavgifter',       vat_rate: 25 },
  '6200': { category: 'utilities',     label: 'Telefoni',                 vat_rate: 25 },
  '6212': { category: 'utilities',     label: 'Mobiltelefon',             vat_rate: 25 },
  '6310': { category: 'admin',         label: 'Företagsförsäkringar',     vat_rate: 0  },
  '6370': { category: 'admin',         label: 'Bevakning & larm',         vat_rate: 25 },
  '6530': { category: 'admin',         label: 'Redovisningstjänster',     vat_rate: 25 },
  '6540': { category: 'admin',         label: 'IT-tjänster',              vat_rate: 25 },
  '6550': { category: 'admin',         label: 'Konsultarvoden',           vat_rate: 25 },
  '6570': { category: 'admin',         label: 'Bankkostnader',            vat_rate: 0  },
  '6590': { category: 'admin',         label: 'Ã–vriga externa tjänster',  vat_rate: 25 },
  '6800': { category: 'admin',         label: 'Inhyrd personal',          vat_rate: 25 },
  '6950': { category: 'admin',         label: 'Tillsynsavgifter',         vat_rate: 0  },
  '6991': { category: 'admin',         label: 'Ã–vriga kostnader',         vat_rate: 25 },
  '6992': { category: 'admin',         label: 'Ej avdragsgilla kostn.',   vat_rate: 0  },
}

// Categorise a cost by account code, with vendor name fallback
export function categoriseByAccountCode(
  accountCode: string,
  vendorName?: string,
  supplierMappings?: Array<{ vendor_contains: string; category: string; category_label: string }>,
): { category: string; label: string; vat_rate: number } {
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
      .sort((a, b) => 0) // already sorted by priority from DB
      .find(m => vendor.includes(m.vendor_contains.toLowerCase()))
    if (match) return { category: match.category, label: match.category_label, vat_rate: 25 }
  }

  // 4. Default to other
  return { category: 'other', label: 'Ã–vrigt', vat_rate: 25 }
}

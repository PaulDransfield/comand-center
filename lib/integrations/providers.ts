// lib/integrations/providers.ts
// Single source of truth for every integration CommandCenter can connect to —
// both the ones we've built sync adapters for, and the ones on the roadmap.
//
// Used by the admin customer detail page's "Add integration" dropdown.
// Supported = we have a working adapter. Planned = on the roadmap, admin can
// still pick it to signal customer demand but no data will flow until the
// adapter is built.
//
// When a new provider is built, add it here with supported: true. That's the
// only place you need to update — the dropdown, registry lookups, and admin
// filters all read from this file.

export type ProviderCategory =
  | 'pos'           // Kassasystem
  | 'reservations'  // Bordsbokning
  | 'accounting'    // Bokföring
  | 'hr'            // HR & Rekrytering
  | 'hotel'         // Hotellsystem
  | 'delivery'      // Leveransplattformar (Foodora, Wolt, Uber Eats)
  | 'other'         // Övriga

export interface Provider {
  key:        string           // internal slug (lowercase, underscore)
  name:       string           // display name
  category:   ProviderCategory
  supported:  boolean          // sync adapter built + tested
  auth_type?: 'api_key' | 'oauth2' | 'none'
  supports_multi_department?: boolean  // true for Inzii, Swess — one key per department
  note?:      string
}

export const PROVIDER_CATEGORIES: { key: ProviderCategory; label: string; order: number }[] = [
  { key: 'pos',          label: 'Kassasystem (POS)',      order: 1 },
  { key: 'accounting',   label: 'Bokföring (Accounting)', order: 2 },
  { key: 'reservations', label: 'Bordsbokning (Reservations)', order: 3 },
  { key: 'hr',           label: 'HR & Rekrytering',       order: 4 },
  { key: 'delivery',     label: 'Leverans (Delivery)',    order: 5 },
  { key: 'hotel',        label: 'Hotellsystem',           order: 6 },
  { key: 'other',        label: 'Övriga',                 order: 7 },
]

export const PROVIDERS: Provider[] = [
  // ── BUILT ──────────────────────────────────────────────────────────────
  { key: 'personalkollen', name: 'Personalkollen', category: 'hr',         supported: true, auth_type: 'api_key' },
  { key: 'fortnox',        name: 'Fortnox',        category: 'accounting', supported: true, auth_type: 'oauth2', note: 'OAuth approval pending from Fortnox' },
  { key: 'inzii',          name: 'Inzii (Swess)',  category: 'pos',        supported: true, auth_type: 'api_key', supports_multi_department: true },
  { key: 'ancon',          name: 'Ancon',          category: 'pos',        supported: true, auth_type: 'api_key' },
  { key: 'caspeco',        name: 'Caspeco',        category: 'pos',        supported: true, auth_type: 'api_key' },
  { key: 'swess',          name: 'Swess',          category: 'pos',        supported: true, auth_type: 'api_key', supports_multi_department: true, note: 'Same API as Inzii — use inzii provider key' },

  // ── ADAPTER STUBS — code exists, not yet verified against live API ─────
  { key: 'trivec',         name: 'Trivec',         category: 'pos',        supported: false, auth_type: 'api_key', note: 'Adapter stub exists (lib/pos/trivec.ts); needs partnership for live access' },
  { key: 'zettle',         name: 'Zettle',         category: 'pos',        supported: false, auth_type: 'oauth2',  note: 'Adapter stub + public dev portal at developer.zettle.com' },
  { key: 'thefork',        name: 'TheFork',        category: 'reservations', supported: false, auth_type: 'oauth2', note: 'Adapter stub + docs at docs.thefork.io' },
  { key: 'foodora',        name: 'Foodora',        category: 'delivery',   supported: false, auth_type: 'oauth2',  note: 'Adapter stub + Partner API at developer.foodora.com' },
  { key: 'wolt',           name: 'Wolt',           category: 'delivery',   supported: false, auth_type: 'oauth2',  note: 'Adapter stub + docs at developer.wolt.com' },
  { key: 'bokad',          name: 'Bokad',          category: 'reservations', supported: false, auth_type: 'api_key', note: 'Adapter stub exists; docs not public' },
  { key: 'quinyx',         name: 'Quinyx',         category: 'hr',         supported: false, auth_type: 'oauth2',  note: 'Adapter stub + enterprise partnership needed' },

  // ── PLANNED — POS ─────────────────────────────────────────────────────
  { key: 'superb',         name: 'Superb',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'gastrogate_pos', name: 'Gastrogate',     category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'pubq',           name: 'PUBQ',           category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'zettle',         name: 'Zettle',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'smartcash',      name: 'Smart Cash',     category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'flow_pos',       name: 'Flow',           category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'yabie',          name: 'Yabie',          category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'trivec',         name: 'Trivec',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'loomis_pay',     name: 'Loomis Pay',     category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'winpos',         name: 'Winpos',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'heynow',         name: 'Heynow',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'vendolink',      name: 'Vendolink',      category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'joboffice',      name: 'JobOffice',      category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'ordine',         name: 'Ordine',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'happy_order',    name: 'Happy Order',    category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'weiq',           name: 'Weiq',           category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'karma_os',       name: 'Karma OS',       category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'nimpos',         name: 'Nimpos',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'microdeb',       name: 'Microdeb',       category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'rebnis',         name: 'Rebnis',         category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'logicash',       name: 'LogiCash',       category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'qopla',          name: 'Qopla',          category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'munu',           name: 'Munu',           category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'northmill',      name: 'Northmill',      category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'openpos',        name: 'OpenPOS',        category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'baemingo',       name: 'Baemingo',       category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'onslip',         name: 'Onslip 360',     category: 'pos',        supported: true,  auth_type: 'api_key', note: 'Hawk auth (HMAC-SHA-256). Credential is a JSON blob: {"key_id":"user+token@realm","key":"base64...","realm":"example.com","env":"prod"}. Obtain from Onslip 360 Backoffice → API access tokens.' },
  { key: 'truepos',        name: 'TruePOS by Kassacentralen', category: 'pos', supported: false, auth_type: 'api_key' },
  { key: 'tickster_blink', name: 'Tickster Blink', category: 'pos',        supported: false, auth_type: 'api_key' },
  { key: 'es_kassasystem', name: 'ES Kassasystem', category: 'pos',        supported: false, auth_type: 'api_key' },

  // ── PLANNED — Accounting ──────────────────────────────────────────────
  { key: 'bjorn_lunden',   name: 'Björn Lundén',   category: 'accounting', supported: false, auth_type: 'api_key' },
  { key: 'highnox_erp',    name: 'Highnox ERP',    category: 'accounting', supported: false, auth_type: 'api_key' },
  { key: 'visma',          name: 'Visma',          category: 'accounting', supported: false, auth_type: 'oauth2' },

  // ── PLANNED — Reservations ────────────────────────────────────────────
  { key: 'gastrogate_res', name: 'Gastrogate',     category: 'reservations', supported: false, auth_type: 'api_key' },
  { key: 'flow_res',       name: 'Flow',           category: 'reservations', supported: false, auth_type: 'api_key' },
  { key: 'superb_res',     name: 'Superb',         category: 'reservations', supported: false, auth_type: 'api_key' },
  { key: 'waiteraid',      name: 'Waiteraid',      category: 'reservations', supported: false, auth_type: 'api_key' },
  { key: 'bordsbokaren',   name: 'Bordsbokaren',   category: 'reservations', supported: false, auth_type: 'api_key' },
  { key: 'truebooking',    name: 'TrueBOOKING by Kassacentralen', category: 'reservations', supported: false, auth_type: 'api_key' },

  // ── PLANNED — HR ──────────────────────────────────────────────────────
  { key: 'time2staff',     name: 'Time2Staff',     category: 'hr',         supported: false, auth_type: 'api_key' },
  { key: 'evity',          name: 'Evity',          category: 'hr',         supported: false, auth_type: 'api_key' },
  { key: 'monotree',       name: 'Monotree',       category: 'hr',         supported: false, auth_type: 'api_key' },
  { key: 'chainformation', name: 'Chainformation', category: 'hr',         supported: false, auth_type: 'api_key' },

  // ── PLANNED — Hotel ───────────────────────────────────────────────────
  { key: 'nitesoft',       name: 'Nitesoft',       category: 'hotel',      supported: false, auth_type: 'api_key' },

  // ── PLANNED — Other ───────────────────────────────────────────────────
  { key: 'skatteverket',   name: 'Skatteverket',   category: 'other',      supported: false, note: 'Swedish tax authority' },
  { key: 'cappy',          name: 'Cappy',          category: 'other',      supported: false, auth_type: 'api_key' },
  { key: 'seamlr',         name: 'Seamlr',         category: 'other',      supported: false, auth_type: 'api_key' },
  { key: 'sculpture_bevchek', name: 'Sculpture Hospitality / BevChek', category: 'other', supported: false, auth_type: 'api_key' },
]

export function getProvider(key: string): Provider | undefined {
  return PROVIDERS.find(p => p.key === key)
}

// Group providers by category, supported ones first within each group
export function groupedProviders(): { category: ProviderCategory; label: string; providers: Provider[] }[] {
  return PROVIDER_CATEGORIES.map(cat => ({
    category: cat.key,
    label:    cat.label,
    providers: PROVIDERS
      .filter(p => p.category === cat.key)
      .sort((a, b) => {
        if (a.supported !== b.supported) return a.supported ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
  })).filter(g => g.providers.length > 0)
}

export function supportedCount(): number {
  return PROVIDERS.filter(p => p.supported).length
}
export function plannedCount(): number {
  return PROVIDERS.filter(p => !p.supported).length
}

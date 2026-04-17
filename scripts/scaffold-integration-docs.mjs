// One-shot scaffold script — writes a starter .md for every provider that
// doesn't already have one. Safe to re-run (won't overwrite existing files).
import fs from 'node:fs'
import path from 'node:path'

const PROVIDERS = [
  // Built (full detail added manually)
  { slug: 'personalkollen',         name: 'Personalkollen',            category: 'HR & staffing',  status: 'built', skip: true },
  { slug: 'fortnox',                name: 'Fortnox',                    category: 'Accounting',     status: 'built', skip: true },
  { slug: 'inzii',                  name: 'Inzii',                      category: 'POS',            status: 'built', skip: true },
  { slug: 'swess',                  name: 'Swess',                      category: 'POS',            status: 'built', skip: true },
  { slug: 'ancon',                  name: 'Ancon',                      category: 'POS',            status: 'built', skip: true },
  { slug: 'caspeco',                name: 'Caspeco',                    category: 'POS',            status: 'built', skip: true },

  // Planned — POS
  { slug: 'superb-pos',             name: 'Superb (POS)',               category: 'POS' },
  { slug: 'gastrogate-pos',         name: 'Gastrogate (POS)',           category: 'POS' },
  { slug: 'pubq',                   name: 'PUBQ',                       category: 'POS' },
  { slug: 'zettle',                 name: 'Zettle (PayPal)',            category: 'POS' },
  { slug: 'smartcash',              name: 'Smart Cash',                 category: 'POS' },
  { slug: 'flow-pos',               name: 'Flow (POS)',                 category: 'POS' },
  { slug: 'yabie',                  name: 'Yabie',                      category: 'POS' },
  { slug: 'trivec',                 name: 'Trivec',                     category: 'POS' },
  { slug: 'loomis-pay',             name: 'Loomis Pay',                 category: 'POS' },
  { slug: 'winpos',                 name: 'Winpos',                     category: 'POS' },
  { slug: 'heynow',                 name: 'Heynow',                     category: 'POS' },
  { slug: 'vendolink',              name: 'Vendolink',                  category: 'POS' },
  { slug: 'joboffice',              name: 'JobOffice',                  category: 'POS' },
  { slug: 'ordine',                 name: 'Ordine',                     category: 'POS' },
  { slug: 'happy-order',            name: 'Happy Order',                category: 'POS' },
  { slug: 'weiq',                   name: 'Weiq',                       category: 'POS' },
  { slug: 'karma-os',               name: 'Karma OS',                   category: 'POS' },
  { slug: 'nimpos',                 name: 'Nimpos',                     category: 'POS' },
  { slug: 'microdeb',               name: 'Microdeb',                   category: 'POS' },
  { slug: 'rebnis',                 name: 'Rebnis',                     category: 'POS' },
  { slug: 'logicash',               name: 'LogiCash',                   category: 'POS' },
  { slug: 'qopla',                  name: 'Qopla',                      category: 'POS' },
  { slug: 'munu',                   name: 'Munu',                       category: 'POS' },
  { slug: 'northmill',              name: 'Northmill',                  category: 'POS' },
  { slug: 'openpos',                name: 'OpenPOS',                    category: 'POS' },
  { slug: 'baemingo',               name: 'Baemingo',                   category: 'POS' },
  { slug: 'onslip',                 name: 'Onslip',                     category: 'POS' },
  { slug: 'truepos',                name: 'TruePOS by Kassacentralen',  category: 'POS' },
  { slug: 'tickster-blink',         name: 'Tickster Blink',             category: 'POS' },
  { slug: 'es-kassasystem',         name: 'ES Kassasystem',             category: 'POS' },

  // Planned — Accounting
  { slug: 'bjorn-lunden',           name: 'Björn Lundén',               category: 'Accounting' },
  { slug: 'highnox-erp',            name: 'Highnox ERP',                category: 'Accounting' },
  { slug: 'visma',                  name: 'Visma',                      category: 'Accounting' },

  // Planned — Reservations
  { slug: 'gastrogate-reservations', name: 'Gastrogate (Reservations)',  category: 'Reservations' },
  { slug: 'flow-reservations',      name: 'Flow (Reservations)',        category: 'Reservations' },
  { slug: 'superb-reservations',    name: 'Superb (Reservations)',      category: 'Reservations' },
  { slug: 'waiteraid',              name: 'Waiteraid',                  category: 'Reservations' },
  { slug: 'bordsbokaren',           name: 'Bordsbokaren',               category: 'Reservations' },
  { slug: 'truebooking',            name: 'TrueBOOKING by Kassacentralen', category: 'Reservations' },

  // Planned — HR
  { slug: 'time2staff',             name: 'Time2Staff',                 category: 'HR' },
  { slug: 'evity',                  name: 'Evity',                      category: 'HR' },
  { slug: 'monotree',               name: 'Monotree',                   category: 'HR' },
  { slug: 'chainformation',         name: 'Chainformation',             category: 'HR' },

  // Planned — Hotel
  { slug: 'nitesoft',               name: 'Nitesoft',                   category: 'Hotel' },

  // Planned — Other
  { slug: 'skatteverket',           name: 'Skatteverket',               category: 'Other' },
  { slug: 'cappy',                  name: 'Cappy',                      category: 'Other' },
  { slug: 'seamlr',                 name: 'Seamlr',                     category: 'Other' },
  { slug: 'sculpture-bevchek',      name: 'Sculpture Hospitality / BevChek', category: 'Other' },
]

const DOCS_DIR = path.resolve('docs/integrations')

function stubContent(p) {
  return `# ${p.name}

## Identity
- **Name (local)**: ${p.name}
- **Category**: ${p.category}
- **Status**: planned
- **Slug**: ${p.slug}

## API technical
- **Docs URL**: NEEDS RESEARCH
- **Developer portal / sandbox URL**: NEEDS RESEARCH
- **Base URL**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: NEEDS RESEARCH
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they expose
NEEDS RESEARCH

## Business / market
- **Sweden market share (rough)**: NEEDS RESEARCH
- **Target segment**: NEEDS RESEARCH
- **Pricing**: NEEDS RESEARCH
- **Support email**: NEEDS RESEARCH
- **Support phone**: NEEDS RESEARCH
- **Partnership status**: NEEDS RESEARCH

## Implementation notes
- **Known gotchas**: —
- **How the customer obtains the key**: NEEDS RESEARCH
- **Skatteverket certified cash register**: NEEDS RESEARCH
- **Supports multi-site / chain**: NEEDS RESEARCH
- **API response language**: NEEDS RESEARCH
- **Build estimate**: NEEDS RESEARCH

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: —
- **Primary contact at provider**: —

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
_Research pass pending — fill in during deep-dive._
`
}

let written = 0
let skipped = 0
for (const p of PROVIDERS) {
  if (p.skip) continue
  const file = path.join(DOCS_DIR, `${p.slug}.md`)
  if (fs.existsSync(file)) { skipped++; continue }
  fs.writeFileSync(file, stubContent(p))
  written++
}
console.log(`Wrote ${written} stub files, skipped ${skipped} existing.`)

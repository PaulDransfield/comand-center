// Mechanical sweep: wrap each page in PageContainer.
//
// For each file in FILES:
//   1. Add `import { PageContainer } from '@/components/ui/Layout'` after
//      the `import AppShell from '@/components/AppShell'` line.
//   2. Replace `<div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>`
//      with `<PageContainer style={{ display: 'grid', gap: 14 }}>`.
//   3. Find the matching closing `</div>` — the one whose next non-blank
//      line is `<AskAI`, `{showAdd && ...`, or `</AppShell>` — and replace
//      with `</PageContainer>`.
//
// DRY by default. Pass --apply to write.
import fs from 'node:fs'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')

const FILES = [
  // Batch 1 — `<div display:grid gap:14 maxWidth:1280>` (already applied)
  ['app/staff/page.tsx',               'GRID_1280'],
  ['app/reviews/page.tsx',             'GRID_1280'],
  ['app/overheads/page.tsx',           'GRID_1280'],
  ['app/revenue/page.tsx',             'GRID_1280'],
  ['app/invoices/page.tsx',            'GRID_1280'],
  ['app/tracker/page.tsx',             'GRID_1280'],
  ['app/budget/page.tsx',              'GRID_1280'],
  ['app/forecast/page.tsx',            'GRID_1280'],
  ['app/group/page.tsx',               'GRID_1280'],
  ['app/departments/page.tsx',         'GRID_1280'],
  ['app/departments/[id]/page.tsx',    'GRID_1280'],
  // Batch 2 — single-prop maxWidth
  ['app/suppliers/page.tsx',           'PLAIN_1280'],
  // Batch 3 — narrow centered (settings family)
  ['app/settings/team/page.tsx',       'NARROW_900'],
  ['app/settings/ai-agents/page.tsx',  'NARROW_900'],
  ['app/settings/ai-agents/[key]/page.tsx', 'NARROW_980'],
  ['app/settings/setup-health/page.tsx', 'NARROW_800'],
  // Batch 4 — wider
  ['app/scheduling/page.tsx',          'WIDE_1400'],
]

const OPEN_PATTERNS = {
  GRID_1280:   `<div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>`,
  PLAIN_1280:  `<div style={{ maxWidth: 1280 }}>`,
  NARROW_900:  `<div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 24px 60px' }}>`,
  NARROW_980:  `<div style={{ maxWidth: 980, margin: '0 auto', padding: '20px 24px 60px' }}>`,
  NARROW_800:  `<div style={{ maxWidth: 800, padding: '20px 24px' }}>`,
  WIDE_1400:   `<div style={{ maxWidth: 1400, padding: '20px 24px' }}>`,
}
const OPEN_REPLACES = {
  GRID_1280:   `<PageContainer style={{ display: 'grid', gap: 14 }}>`,
  PLAIN_1280:  `<PageContainer>`,
  NARROW_900:  `<PageContainer maxWidth={900}>`,
  NARROW_980:  `<PageContainer maxWidth={980}>`,
  NARROW_800:  `<PageContainer maxWidth={800}>`,
  WIDE_1400:   `<PageContainer maxWidth={1400}>`,
}
const IMPORT_AFTER  = `import AppShell from '@/components/AppShell'`
const IMPORT_ADD    = `import { PageContainer } from '@/components/ui/Layout'`

for (const [rel, kind] of FILES) {
  const abs = path.resolve(rel)
  if (!fs.existsSync(abs)) { console.log(`SKIP ${rel}: not found`); continue }
  let src = fs.readFileSync(abs, 'utf-8')

  // Skip if already converted
  if (src.includes('PageContainer')) { console.log(`SKIP ${rel}: already has PageContainer`); continue }

  const OPEN_PATTERN = OPEN_PATTERNS[kind]
  const OPEN_REPLACE = OPEN_REPLACES[kind]
  const hadOpen = src.includes(OPEN_PATTERN)
  const hadImport = src.includes(IMPORT_AFTER)
  if (!hadOpen) { console.log(`SKIP ${rel}: no matching open pattern (${kind})`); continue }
  if (!hadImport) { console.log(`SKIP ${rel}: no AppShell import anchor`); continue }

  // 1. Insert import
  src = src.replace(IMPORT_AFTER, `${IMPORT_AFTER}\n${IMPORT_ADD}`)

  // 2. Open swap
  src = src.replace(OPEN_PATTERN, OPEN_REPLACE)

  // 3. Find matching close. The pattern that works for these pages: the
  //    closing `</div>` is at indent 6 spaces, and is followed by one of:
  //    - blank line + `      <AskAI`
  //    - blank line + `      {`  (modal state guard)
  //    - blank line + `      </AppShell>` (no AskAI)
  //    Match the last `      </div>` followed by `\n\n      <AskAI` first;
  //    fallback to `\n\n      {` or `\n    </AppShell>` if the first
  //    pattern is absent.
  let beforeCount = (src.match(/^      <\/div>$/gm) || []).length
  let didClose = false
  // Normalise EOL — file may be CRLF or LF. Detect.
  const EOL = src.includes('\r\n') ? '\r\n' : '\n'
  // Priority order: most-specific anchors FIRST so we don't replace an
  // inner `</div>` whose next sibling happens to be `{...}`. The chrome
  // wrap's close is uniquely identifiable by the AppShell-close anchor
  // (and only-1-of-them) or by the floating <AskAI> sibling.
  const PATTERNS = [
    { from: `${EOL}      </div>${EOL}    </AppShell>`,     to: `${EOL}      </PageContainer>${EOL}    </AppShell>` },
    { from: `${EOL}      </div>${EOL}${EOL}    </AppShell>`, to: `${EOL}      </PageContainer>${EOL}${EOL}    </AppShell>` },
    { from: `${EOL}      </div>${EOL}${EOL}      <AskAI`,  to: `${EOL}      </PageContainer>${EOL}${EOL}      <AskAI` },
    { from: `${EOL}      </div>${EOL}      <AskAI`,        to: `${EOL}      </PageContainer>${EOL}      <AskAI` },
    // FALLBACK — chrome close followed by a blank line then a JSX-fragment guard.
    { from: `${EOL}      </div>${EOL}${EOL}      {`,       to: `${EOL}      </PageContainer>${EOL}${EOL}      {` },
    { from: `${EOL}      </div>${EOL}      {`,             to: `${EOL}      </PageContainer>${EOL}      {` },
  ]
  for (const p of PATTERNS) {
    if (src.includes(p.from)) {
      src = src.replace(p.from, p.to)
      didClose = true
      break
    }
  }
  if (!didClose) { console.log(`WARN ${rel}: open swapped but no matching close pattern found`); continue }

  console.log(`OK   ${rel}`)
  if (APPLY) fs.writeFileSync(abs, src)
}

console.log(`\n${APPLY ? 'APPLIED' : 'DRY (use --apply to write)'}`)

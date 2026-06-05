// scripts/diag/refresh-ms-empty.mjs
//
// Re-fetch the Martin Servera rows that landed with fetch_status='ok' but
// no image_url / no specs data. Likely transient network failures or
// pre-render-stale page snapshots from the original scrape.
//
// Usage:
//   node scripts/diag/refresh-ms-empty.mjs        # DRY
//   node scripts/diag/refresh-ms-empty.mjs --apply
//
// Reuses scrape-martinservera.mjs's article-level extractor via subprocess
// (avoids re-implementing the Playwright + age-gate logic). Each spawn
// processes one article number via `--article N --apply`.

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

console.log('Finding MS rows with ok status but empty image_url...')
const { data: targets } = await db.from('supplier_articles')
  .select('article_number, official_name')
  .eq('source', 'martinservera_scrape').eq('fetch_status', 'ok')
  .is('image_url', null).range(0, 999)
console.log(`Found ${targets.length} targets`)
if (targets.length === 0) process.exit(0)

if (!APPLY) {
  for (const t of targets.slice(0, 20)) console.log(`  ${t.article_number}  ${t.official_name}`)
  if (targets.length > 20) console.log(`  ... + ${targets.length - 20} more`)
  console.log('\n(DRY — re-run with --apply to re-scrape)')
  process.exit(0)
}

function runOne(article) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['scripts/diag/scrape-martinservera.mjs', '--article', article, '--apply'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', d => stdout += d.toString())
    proc.stderr.on('data', d => stderr += d.toString())
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

let ok = 0, fail = 0
for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  process.stdout.write(`[${i+1}/${targets.length}] ${t.article_number}  ${t.official_name?.slice(0, 40)} ... `)
  const res = await runOne(t.article_number)
  if (res.code === 0) {
    process.stdout.write(`OK\n`)
    ok++
  } else {
    process.stdout.write(`FAIL code=${res.code}\n`)
    if (res.stderr) console.error('  ' + res.stderr.slice(0, 200))
    fail++
  }
}
console.log(`\nok=${ok}  fail=${fail}  total=${targets.length}`)

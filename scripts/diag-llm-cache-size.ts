// scripts/diag-llm-cache-size.ts
// Count_tokens probe against the LIVE production llm-adjust prompt.
// Run: npx tsx scripts/diag-llm-cache-size.ts

import { readFileSync } from 'node:fs'

function parseEnv(path: string) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8').split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
        })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') } as Record<string, string>
const KEY = env.ANTHROPIC_API_KEY
if (!KEY) { console.error('missing ANTHROPIC_API_KEY'); process.exit(1) }

// Pull the actual ROLE_AND_RULES + SCHEMA_AND_EXAMPLES from the deployed file.
// llm-adjust.ts doesn't export them, so we use a regex to slice them out of
// the source. Crude but keeps the script honest — measures what's deployed.
const src = readFileSync('lib/forecast/llm-adjust.ts', 'utf8')
function extract(name: string): string {
  const m = src.match(new RegExp(`const ${name}\\s*=\\s*\`([\\s\\S]*?)\``))
  if (!m) throw new Error(`could not extract ${name} from llm-adjust.ts`)
  return m[1]
}
// SCOPE_NOTE comes from lib/ai/scope.ts and is interpolated into ROLE_AND_RULES
const scopeSrc = readFileSync('lib/ai/scope.ts', 'utf8')
const scopeMatch = scopeSrc.match(/export const SCOPE_NOTE\s*=\s*`([\s\S]*?)`/)
if (!scopeMatch) throw new Error('could not extract SCOPE_NOTE')
const SCOPE_NOTE = scopeMatch[1]

const ROLE_AND_RULES_RAW = extract('ROLE_AND_RULES')
const ROLE_AND_RULES = ROLE_AND_RULES_RAW.replace('${SCOPE_NOTE}', SCOPE_NOTE)
const SCHEMA_AND_EXAMPLES = extract('SCHEMA_AND_EXAMPLES')
const SYSTEM_PROMPT = ROLE_AND_RULES + '\n\n' + SCHEMA_AND_EXAMPLES

// Tool def — keep in sync with llm-adjust.ts
const submitAdjustmentTool = {
  name: 'submit_revenue_adjustment',
  description: 'Submit a multiplicative adjustment to the deterministic revenue forecast. Use 1.0 to leave the forecast unchanged. Only deviate from 1.0 when you see context the deterministic signals could not see.',
  input_schema: {
    type: 'object',
    properties: {
      adjustment_factor: { type: 'number', description: 'Multiplicative factor in [0.5, 1.5]. 1.0 = no change.' },
      reasoning:         { type: 'string', description: 'One paragraph (≤400 chars) plain English.' },
      confidence:        { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['adjustment_factor', 'reasoning', 'confidence'],
  },
}

async function countTokens(body: any) {
  const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`count_tokens ${r.status}: ${t.slice(0, 300)}`)
  return JSON.parse(t)
}

async function main() {
const userMin = [{ role: 'user', content: 'x' }]
const cFull = await countTokens({ model: 'claude-haiku-4-5-20251001', system: [{ type: 'text', text: SYSTEM_PROMPT }], tools: [submitAdjustmentTool], messages: userMin })
const cNoTools = await countTokens({ model: 'claude-haiku-4-5-20251001', system: [{ type: 'text', text: SYSTEM_PROMPT }], messages: userMin })
const cUser = await countTokens({ model: 'claude-haiku-4-5-20251001', messages: userMin })

console.log('── Deployed llm-adjust prompt size ──')
console.log(`  ROLE_AND_RULES chars:        ${ROLE_AND_RULES.length}`)
console.log(`  SCHEMA_AND_EXAMPLES chars:   ${SCHEMA_AND_EXAMPLES.length}`)
console.log(`  SCOPE_NOTE chars:            ${SCOPE_NOTE.length}`)
console.log(`  SYSTEM_PROMPT chars:         ${SYSTEM_PROMPT.length}`)
console.log()
console.log(`  user-only input_tokens:      ${cUser.input_tokens}`)
console.log(`  + system input_tokens:       ${cNoTools.input_tokens - cUser.input_tokens}`)
console.log(`  + tools input_tokens:        ${cFull.input_tokens - cNoTools.input_tokens}`)
console.log(`  → cacheable prefix:          ${cFull.input_tokens - cUser.input_tokens} tokens`)
console.log()
const prefix = cFull.input_tokens - cUser.input_tokens
const HAIKU_45_MIN = 4096  // empirically determined 2026-05-11 — see ROADMAP
console.log(`  Haiku 4.5 empirical minimum: ~${HAIKU_45_MIN} tokens`)
console.log(`  → above minimum + 200 buffer (${HAIKU_45_MIN + 200})?  ${prefix >= HAIKU_45_MIN + 200 ? 'YES ✓' : `NO ✗ — add ~${HAIKU_45_MIN + 200 - prefix} more tokens`}`)

// Real end-to-end test against current deployed prompt
console.log('\n── Live cache test (2 calls with the deployed prompt) ──')
async function send(label: string) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      tools: [{ ...submitAdjustmentTool, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'submit_revenue_adjustment' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Return factor 1.0 with reasoning "diagnostic ping".' }],
    }),
  })
  const t = await r.text()
  if (!r.ok) { console.log(`  ${label}: HTTP ${r.status} ${t.slice(0, 200)}`); return }
  const j = JSON.parse(t)
  const u = j.usage ?? {}
  console.log(`  ${label}: input=${u.input_tokens} create=${u.cache_creation_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0}`)
}
await send('Call 1')
await send('Call 2')
}
main().catch(e => { console.error(e); process.exit(1) })

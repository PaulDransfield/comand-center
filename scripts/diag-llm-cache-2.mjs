#!/usr/bin/env node
// scripts/diag-llm-cache-2.mjs
//
// Follow-up: diag-llm-cache.mjs proved the cacheable prefix is 2,532
// tokens (above Haiku 4.5's 2,048 minimum) and cache is STILL 0/0.
// So size is not the issue. Try variations to isolate:
//
//   A. Same call against Sonnet 4.6 — does caching work on a different model?
//   B. cache_control on system only (no marker on tool)
//   C. cache_control with anthropic-beta:prompt-caching-2024-07-31 header
//      (legacy beta — may behave differently if GA isn't actually live for
//      this account/model)
//   D. cache_control with the 1h beta header
//
// Each variant runs twice so we can see creation+read.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
        })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const KEY = env.ANTHROPIC_API_KEY
if (!KEY) { console.error('missing ANTHROPIC_API_KEY'); process.exit(1) }

// A long-enough system prompt to clear ANY model's minimum (Sonnet 1024, Haiku 2048).
// ~3000 tokens of stable text.
const FILLER = `You are a forecast review assistant for a Swedish restaurant business intelligence product called CommandCenter. The product analyses restaurant revenue, costs, and operational data to surface anomalies, predict trends, and recommend operational changes. Your role is one specific job: review a deterministic daily revenue forecast and decide whether it needs a small multiplicative adjustment based on context the deterministic signals cannot themselves capture. `.repeat(20)

const SYSTEM_PROMPT = FILLER + '\n\nReturn responses via the supplied tool only.'

const tool = {
  name: 'submit_adjustment',
  description: 'Submit a multiplicative adjustment factor in [0.5, 1.5].',
  input_schema: {
    type: 'object',
    properties: {
      factor: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['factor', 'reason'],
  },
}

async function send({ model, label, system, tools, betas = [] }) {
  const headers = {
    'content-type':      'application/json',
    'x-api-key':         KEY,
    'anthropic-version': '2023-06-01',
  }
  if (betas.length) headers['anthropic-beta'] = betas.join(',')

  const body = {
    model,
    max_tokens: 64,
    tools,
    tool_choice: { type: 'tool', name: 'submit_adjustment' },
    system,
    messages: [{ role: 'user', content: 'Return factor 1.0 with reason "ping".' }],
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  const t = await r.text()
  if (!r.ok) {
    console.log(`  ${label}: HTTP ${r.status} — ${t.slice(0, 200)}`)
    return null
  }
  const j = JSON.parse(t)
  const u = j.usage ?? {}
  console.log(`  ${label}:`)
  console.log(`    model=${j.model}`)
  console.log(`    input_tokens=${u.input_tokens} cache_creation=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`)
  return u
}

async function variant(name, opts) {
  console.log(`\n── ${name} ─────────────────────────────────────`)
  await send({ ...opts, label: 'Call 1' })
  await send({ ...opts, label: 'Call 2' })
}

const sysWithCache = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]
const sysNoCache   = [{ type: 'text', text: SYSTEM_PROMPT }]
const toolWithCache = [{ ...tool, cache_control: { type: 'ephemeral' } }]
const toolNoCache   = [tool]

// A. Sonnet 4.6 same body as the prod llm-adjust path
await variant('A. Sonnet 4.6, cache_control on system + tool', {
  model:  'claude-sonnet-4-6',
  system: sysWithCache,
  tools:  toolWithCache,
})

// B. Haiku 4.5, cache_control on system only
await variant('B. Haiku 4.5, cache_control on SYSTEM only', {
  model:  'claude-haiku-4-5-20251001',
  system: sysWithCache,
  tools:  toolNoCache,
})

// C. Haiku 4.5, with legacy prompt-caching beta header
await variant('C. Haiku 4.5, anthropic-beta:prompt-caching-2024-07-31', {
  model:  'claude-haiku-4-5-20251001',
  system: sysWithCache,
  tools:  toolWithCache,
  betas:  ['prompt-caching-2024-07-31'],
})

// D. Haiku 4.5, with extended-cache-ttl beta header (for ttl:'5m' acceptance)
await variant('D. Haiku 4.5, anthropic-beta:extended-cache-ttl-2025-04-11', {
  model:  'claude-haiku-4-5-20251001',
  system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '5m' } }],
  tools:  toolWithCache,
  betas:  ['extended-cache-ttl-2025-04-11'],
})

// E. Haiku 4.5, cache_control on TOOL only (not system)
await variant('E. Haiku 4.5, cache_control on TOOL only', {
  model:  'claude-haiku-4-5-20251001',
  system: sysNoCache,
  tools:  toolWithCache,
})

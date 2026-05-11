#!/usr/bin/env node
// scripts/diag-llm-cache-3.mjs
//
// Two confirmations:
//   F. 3-call Sonnet 4.6 sequence — verify cache READ on call 3 (the
//      2-call Sonnet test in diag #2 showed cache_creation=0 on call 1
//      and cache_creation=2221 on call 2, which is unusual — need to
//      see if calls 3+ then READ that cache).
//   G. Haiku 4.5 with a MUCH larger system prompt (~6,000 tokens) —
//      maybe Haiku 4.5's effective minimum is higher than the 2,048
//      documented for Haiku 3.x.

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

const tool = {
  name: 'submit_adjustment',
  description: 'Submit a multiplicative adjustment factor in [0.5, 1.5].',
  input_schema: {
    type: 'object',
    properties: { factor: { type: 'number' }, reason: { type: 'string' } },
    required: ['factor', 'reason'],
  },
}

async function send(model, system, label, betas = []) {
  const headers = {
    'content-type':      'application/json',
    'x-api-key':         KEY,
    'anthropic-version': '2023-06-01',
  }
  if (betas.length) headers['anthropic-beta'] = betas.join(',')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers,
    body: JSON.stringify({
      model,
      max_tokens: 64,
      tools:       [{ ...tool, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'submit_adjustment' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Return factor 1.0 with reason "ping".' }],
    }),
  })
  const t = await r.text()
  if (!r.ok) { console.log(`  ${label}: HTTP ${r.status} ${t.slice(0,200)}`); return }
  const j = JSON.parse(t)
  const u = j.usage ?? {}
  console.log(`  ${label}: input=${u.input_tokens} create=${u.cache_creation_input_tokens ?? 0} read=${u.cache_read_input_tokens ?? 0}`)
}

const SHORT_SYS = `You are a forecast review assistant for a Swedish restaurant business intelligence product called CommandCenter. The product analyses restaurant revenue, costs, and operational data. Your role is one specific job: review a deterministic daily revenue forecast and decide whether it needs a small multiplicative adjustment based on context the deterministic signals cannot themselves capture. `.repeat(20) + '\n\nReturn responses via the supplied tool only.'

// ~6,000 token prompt
const LONG_SYS = SHORT_SYS + '\n\n' + SHORT_SYS + '\n\n' + SHORT_SYS

console.log('── F. Sonnet 4.6, 3 calls in a row ─────────────────────')
await send('claude-sonnet-4-6', SHORT_SYS, 'Call 1')
await send('claude-sonnet-4-6', SHORT_SYS, 'Call 2')
await send('claude-sonnet-4-6', SHORT_SYS, 'Call 3')

console.log('\n── G. Haiku 4.5, ~6,000 token system prompt, 2 calls ────')
await send('claude-haiku-4-5-20251001', LONG_SYS, 'Call 1')
await send('claude-haiku-4-5-20251001', LONG_SYS, 'Call 2')

console.log('\n── H. Haiku 4.5, ~6,000 token system, with extended-cache-ttl beta ────')
await send('claude-haiku-4-5-20251001', LONG_SYS, 'Call 1', ['extended-cache-ttl-2025-04-11'])
await send('claude-haiku-4-5-20251001', LONG_SYS, 'Call 2', ['extended-cache-ttl-2025-04-11'])

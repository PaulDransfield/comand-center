// lib/ai/cost.ts
//
// Cost calculation for Claude API calls. Single source of truth — update here
// when Anthropic changes their rates or our USD/SEK assumption shifts.
//
// Rates as of 2026-04 (Anthropic pricing page). If rates change, update here
// AND note it in FIXES.md so historical audit trails stay accurate.

// USD per million tokens
export const CLAUDE_RATES = {
  'claude-haiku-4-5-20251001': { input_per_mtok: 1.00,  output_per_mtok: 5.00  },
  'claude-sonnet-4-6':         { input_per_mtok: 3.00,  output_per_mtok: 15.00 },
  // Legacy / fallback — assume Sonnet rate if unknown (conservative — don't
  // underestimate cost on unexpected models).
  'default':                   { input_per_mtok: 3.00,  output_per_mtok: 15.00 },
} as const

// USD→SEK. Kept as a constant for now; can be wired to an FX feed later if
// precision matters. Real rate in April 2026 is ~10.5 SEK per USD; we round
// conservatively UP so billing estimates are pessimistic.
export const USD_TO_SEK = 11.0

export function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rates = (CLAUDE_RATES as any)[model] ?? CLAUDE_RATES.default
  const usd   = (inputTokens / 1_000_000) * rates.input_per_mtok
              + (outputTokens / 1_000_000) * rates.output_per_mtok
  // Round to 6 decimals — storing fractions of a cent is fine, just don't blow
  // up Postgres numeric precision with floating-point noise.
  return Math.round(usd * 1_000_000) / 1_000_000
}

export function usdToSek(usd: number): number {
  return Math.round(usd * USD_TO_SEK * 100) / 100  // 2 decimals, öre-precision
}

export function calcCostSek(model: string, inputTokens: number, outputTokens: number): number {
  return usdToSek(calcCostUsd(model, inputTokens, outputTokens))
}

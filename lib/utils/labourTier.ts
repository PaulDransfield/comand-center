// lib/utils/labourTier.ts
//
// Single source of truth for labour-cost-as-%-of-revenue classification.
// Used by /scheduling (per-day AI recommendation hero + rows) and /staff
// (daily bar chart + best-day / highest-cost-day callouts).
//
// Four tiers, range-based so a day at 34.9% doesn't feel identical to a
// day at 35.1% while being coloured differently. The "low" tier is its
// own band because very low labour % can indicate understaffing, which
// the operator should verify rather than celebrate.
//
// Config per business: `businesses.labour_target_min / max / watch_ceiling`
// (not yet in schema — see TODO in caller). Until those columns exist,
// every caller uses DEFAULT_TIER_CONFIG.

import { UX } from '@/lib/constants/tokens'

export type LabourTier = 'low' | 'on-target' | 'watch' | 'over' | 'no-data'

export interface LabourTierConfig {
  targetMin:    number  // default 30
  targetMax:    number  // default 35
  watchCeiling: number  // default 50 (target max + 15 pp)
}

export const DEFAULT_TIER_CONFIG: LabourTierConfig = {
  targetMin:    30,
  targetMax:    35,
  watchCeiling: 50,
}

/**
 * Return the tier for a labour percentage.
 *
 * Pass `null` / `undefined` when the day has no predicted revenue (we can't
 * compute a percentage) and receive `'no-data'` so the caller knows to
 * render a neutral chip instead of miscolouring.
 */
export function labourTier(
  pct:  number | null | undefined,
  cfg:  LabourTierConfig = DEFAULT_TIER_CONFIG,
): LabourTier {
  if (pct == null || !Number.isFinite(pct)) return 'no-data'
  if (pct < cfg.targetMin)       return 'low'
  if (pct <= cfg.targetMax)      return 'on-target'
  if (pct <= cfg.watchCeiling)   return 'watch'
  return 'over'
}

export interface TierStyle {
  bg:    string
  ink:   string
  label: string
}

/**
 * Colour pair for a tier. Indigo for 'low' because it's a flag, not a
 * pass — the operator needs to verify the low hours are intentional.
 */
export function labourTierStyle(tier: LabourTier): TierStyle {
  switch (tier) {
    case 'low':       return { bg: UX.indigoBg,  ink: '#4338ca',    label: 'below target' }
    case 'on-target': return { bg: UX.greenBg,   ink: UX.greenInk,  label: 'on target' }
    case 'watch':     return { bg: UX.amberBg,   ink: UX.amberInk,  label: 'watch' }
    case 'over':      return { bg: UX.redBg,     ink: UX.redInk2,   label: 'over' }
    case 'no-data':   return { bg: UX.subtleBg,  ink: UX.ink4 ?? '#9ca3af', label: 'no data' }
  }
}

export function fmtTierPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  return `${Math.round(pct * 10) / 10}%`
}

// Helper for "within target range" / "N pp over" context lines.
export function tierDelta(pct: number | null | undefined, cfg: LabourTierConfig = DEFAULT_TIER_CONFIG): {
  kind: 'within' | 'above' | 'below' | 'unknown'
  pp:   number  // absolute distance from the nearest edge of the range
} {
  if (pct == null || !Number.isFinite(pct)) return { kind: 'unknown', pp: 0 }
  if (pct < cfg.targetMin)  return { kind: 'below',  pp: +(cfg.targetMin - pct).toFixed(1) }
  if (pct <= cfg.targetMax) return { kind: 'within', pp: 0 }
  return { kind: 'above', pp: +(pct - cfg.targetMax).toFixed(1) }
}

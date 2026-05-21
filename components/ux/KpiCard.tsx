'use client'
// components/ux/KpiCard.tsx
//
// Canonical KPI card for the redesigned surfaces. Replaces the
// three coexisting patterns audited in §2.8:
//   - components/dashboard/KPICard.tsx (CSS variables)
//   - lib/constants/colors.ts::KPI_CARD style object
//   - inline-built KPI cards in app/dashboard/page.tsx
//
// Phase 1 only DEFINES this — pages migrate to it from Phase 2 onward.
//
// Variants (a single card supports one — passed via `variant`):
//   - 'plain'        → title + bigNumber + delta
//   - 'channels'     → + legend rows + % + one stacked horizontal bar
//   - 'stacked'      → + two labelled bars
//   - 'targetBand'   → + marker bar with 30–35% green band
//
// Exact tokens used verbatim from the Phase 1 prompt — do not approximate.

import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import type { ReactNode } from 'react'

export type KpiVariant = 'plain' | 'channels' | 'stacked' | 'targetBand'

export interface KpiChannel {
  label: string
  value: number
  share: number   // 0–1, share of total
  color: string
}

export interface KpiStackedBar {
  label: string
  value: number   // raw value for the bar
  max:   number   // 100% reference
  color: string
}

export interface KpiTargetBand {
  actualPct:    number   // 0–100
  targetMinPct: number   // e.g. 30
  targetMaxPct: number   // e.g. 35
}

export interface KpiCardProps {
  title:        string
  /** Pre-formatted value string. Use fmtKr / fmtPct from lib/format. */
  value:        string
  /** Delta vs comparison period — sign included ("+9.6%", "-1 200 kr"). */
  delta?:       string | null
  /** When true, delta-up = good (revenue / margin). When false, delta-up = bad (cost). */
  deltaGood?:   boolean
  variant?:     KpiVariant
  channels?:    KpiChannel[]
  stackedBars?: [KpiStackedBar, KpiStackedBar]
  targetBand?:  KpiTargetBand
  microLabel?:  string
  /** Optional render slot below the main metric — escape hatch for one-offs. */
  extra?:       ReactNode
}

// ── Shared exact tokens (verbatim from Phase 1 prompt) ─────────────
const card        = { background: '#fff', borderRadius: 12, padding: '14px 16px' } as const
const cardBorder  = '0.5px solid rgba(58,53,80,0.08)'
const bigNumber   = {
  fontFamily:         'var(--font-display)',
  fontSize:           22,
  fontWeight:         500,
  letterSpacing:      '-0.02em',
  fontVariantNumeric: 'tabular-nums' as const,
  color:              UXP.ink1,
  lineHeight:         1.1,
} as const
const label       = { fontSize: 11, color: 'rgba(58,53,80,0.6)' } as const
const microLabel  = { fontSize: 9, letterSpacing: '0.04em', color: 'rgba(58,53,80,0.5)', textTransform: 'uppercase' as const } as const
const deltaPos    = { fontSize: 10, color: UXP.green, fontVariantNumeric: 'tabular-nums' as const } as const
const deltaNeg    = { fontSize: 10, color: UXP.rose,  fontVariantNumeric: 'tabular-nums' as const } as const

export default function KpiCard({
  title, value, delta, deltaGood = true,
  variant = 'plain', channels, stackedBars, targetBand,
  microLabel: micro, extra,
}: KpiCardProps) {
  const deltaSign = delta?.[0]
  const isPositive = deltaSign === '+' || deltaSign === '↗'
  const isNegative = deltaSign === '-' || deltaSign === '−' || deltaSign === '↘'
  // "Good" delta = the sign that we want for this metric. Revenue-up = good
  // (deltaGood=true, sign=+). Cost-up = bad (deltaGood=false, sign=+ → bad).
  const isGood = delta == null
    ? null
    : deltaGood ? isPositive : isNegative
  const deltaStyle = isGood == null
    ? { fontSize: 10, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }
    : isGood ? deltaPos : deltaNeg

  return (
    <div style={{ ...card, border: cardBorder }}>
      {micro && <div style={{ ...microLabel, marginBottom: 4 }}>{micro}</div>}
      <div style={{ ...label, marginBottom: 4 }}>{title}</div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={bigNumber}>{value}</span>
        {delta && <span style={deltaStyle}>{delta}</span>}
      </div>

      {variant === 'channels'    && channels?.length    && <ChannelsBlock channels={channels} />}
      {variant === 'stacked'     && stackedBars         && <StackedBlock bars={stackedBars} />}
      {variant === 'targetBand'  && targetBand          && <TargetBandBlock band={targetBand} />}
      {extra}
    </div>
  )
}

// ── Variant blocks ─────────────────────────────────────────────────

function ChannelsBlock({ channels }: { channels: KpiChannel[] }) {
  const total = channels.reduce((s, c) => s + c.value, 0)
  return (
    <div style={{ marginTop: 4 }}>
      {/* Legend rows */}
      <div style={{ display: 'grid', gap: 3, marginBottom: 8 }}>
        {channels.map(c => {
          const pct = total > 0 ? (c.value / total) * 100 : 0
          return (
            <div
              key={c.label}
              style={{ display: 'grid', gridTemplateColumns: '8px 1fr auto', gap: 6, alignItems: 'center', fontSize: 10 }}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
              <span style={{ color: UXP.ink2 }}>{c.label}</span>
              <span style={{ color: UXP.ink3, fontVariantNumeric: 'tabular-nums' }}>{pct.toFixed(0)}%</span>
            </div>
          )
        })}
      </div>
      {/* Single stacked horizontal bar */}
      <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', background: UXP.lavFill }}>
        {channels.map(c => {
          const w = total > 0 ? (c.value / total) * 100 : 0
          return <span key={c.label} style={{ width: `${w}%`, background: c.color }} />
        })}
      </div>
    </div>
  )
}

function StackedBlock({ bars }: { bars: [KpiStackedBar, KpiStackedBar] }) {
  return (
    <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
      {bars.map(b => {
        const w = b.max > 0 ? Math.min(100, (b.value / b.max) * 100) : 0
        return (
          <div key={b.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2, fontSize: 10, color: UXP.ink3 }}>
              <span>{b.label}</span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(w)}%</span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: UXP.lavFill, overflow: 'hidden' }}>
              <span style={{ display: 'block', width: `${w}%`, height: '100%', background: b.color }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function TargetBandBlock({ band }: { band: KpiTargetBand }) {
  // Marker bar 0–100%. Band lives between targetMin and targetMax (green
  // wash). Marker dot at actualPct.
  const min  = Math.max(0, Math.min(100, band.targetMinPct))
  const max  = Math.max(0, Math.min(100, band.targetMaxPct))
  const act  = Math.max(0, Math.min(100, band.actualPct))
  const onTarget = act >= min && act <= max
  const markerColour = onTarget ? UXP.green : (act > max ? UXP.rose : UXP.coral)

  return (
    <div style={{ marginTop: 8, position: 'relative' as const, height: 14 }}>
      {/* Track */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 6,
        height: 2, background: UXP.lavFill, borderRadius: 1,
      }} />
      {/* Band */}
      <div style={{
        position: 'absolute', left: `${min}%`, width: `${max - min}%`, top: 4,
        height: 6, background: UXP.greenFill, border: `0.5px solid ${UXP.green}`,
        borderRadius: 3,
      }} />
      {/* Marker */}
      <div style={{
        position: 'absolute', left: `calc(${act}% - 5px)`, top: 2,
        width: 10, height: 10, borderRadius: '50%',
        background: markerColour, border: '1.5px solid #fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
      }} />
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 14,
        display: 'flex', justifyContent: 'space-between',
        fontSize: 9, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const,
      }}>
        <span>0%</span>
        <span>{fmtPct(act)} actual</span>
        <span>100%</span>
      </div>
    </div>
  )
}

// Re-export the helpers so callers don't have to import from two places.
export { fmtKr, fmtPct }

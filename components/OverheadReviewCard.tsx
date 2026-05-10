// components/OverheadReviewCard.tsx
//
// Dashboard "Overheads review" pillar card. v8 redesign:
//   - Amber-stripe left border
//   - Header: label + amber "N pending" status pill
//   - Big 38px before/after numbers (current margin → projected margin)
//   - Context paragraph with strong emphasis on key kr values
//   - 3-cell mini stat row (Saves / Pending / Current run-rate)
//   - Dark CTA button: "Review overheads →"
//
// Conditional visibility (rendered by parent dashboard):
//   - businessId selected
//   - pending_count > 0 AND total_savings_sek > 0
//   - Fortnox connected (implicit — no flags exist without tracker_line_items)
//
// FIXES.md §0ap.

'use client'

import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface ProjectionData {
  current:   { overheads_sek: number; net_profit_sek: number; margin_pct: number }
  projected: { overheads_sek: number; net_profit_sek: number; margin_pct: number }
  savings:   { total_sek: number }
  pending_count: number
  period:    { year: number; month: number }
}

export function OverheadReviewCard({ data }: { data: ProjectionData }) {
  const currentMargin   = Math.round(data.current.margin_pct)
  const projectedMargin = Math.round(data.projected.margin_pct)

  return (
    <a
      href="/overheads/review"
      style={cardLink}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
    >
      {/* Header — eyebrow on the left, status pill on the right */}
      <div style={pillarHead}>
        <span style={pillarHLabel}>Overheads review</span>
        <span style={{ ...pillarStatus, background: UX.amberBg, color: UX.amberInk }}>
          {data.pending_count} pending
        </span>
      </div>

      <div style={pillarBody}>
        {/* Big before/after numbers */}
        <div style={baRow}>
          <span style={{ ...baCurrent, color: UX.amberInk }}>{currentMargin}%</span>
          <span style={baArrow}>→</span>
          <span style={{ ...baProjected }}>{projectedMargin}%</span>
          <span style={baSuffix}>net margin</span>
        </div>

        {/* Context — single paragraph, strong-emphasised numbers */}
        <p style={pillarContext}>
          Overheads run <strong style={pillarStrong}>{fmtKr(data.current.overheads_sek)}/mo</strong>.
          Cancelling {data.pending_count} flagged item{data.pending_count === 1 ? '' : 's'} drops them
          to <strong style={pillarStrong}>{fmtKr(data.projected.overheads_sek)}/mo</strong> and lifts
          net margin from <strong style={pillarStrong}>{currentMargin}%</strong> to{' '}
          <strong style={pillarStrong}>{projectedMargin}%</strong>.
        </p>

        {/* Mini stat row — 3 cells separated by hairlines */}
        <div style={pillarStats}>
          <div style={pillarStatCell}>
            <div style={pillarStatLabel}>Saves</div>
            <div style={{ ...pillarStatValue, color: UX.greenInk }}>{fmtKr(data.savings.total_sek)}/mo</div>
          </div>
          <div style={pillarStatCell}>
            <div style={pillarStatLabel}>Pending</div>
            <div style={pillarStatValue}>{data.pending_count} flag{data.pending_count === 1 ? '' : 's'}</div>
          </div>
          <div style={pillarStatCell}>
            <div style={pillarStatLabel}>Current</div>
            <div style={pillarStatValue}>{fmtKr(data.current.overheads_sek)}/mo</div>
          </div>
        </div>

        {/* No onClick handler — the parent anchor handles navigation. The
            button is purely cosmetic (visual CTA) and shouldn't trap clicks. */}
        <span style={pillarCta as React.CSSProperties}>
          Review overheads <span aria-hidden style={{ fontSize: 14 }}>→</span>
        </span>
      </div>
    </a>
  )
}

// ─── styles ──────────────────────────────────────────────────────────────────

const cardLink: React.CSSProperties = {
  background:     UX.cardBg,
  border:         `1px solid ${UX.border}`,
  borderLeft:     `4px solid ${UX.amberInk}`,
  borderRadius:   12,
  padding:        0,
  overflow:       'hidden' as const,
  textDecoration: 'none',
  color:          'inherit',
  cursor:         'pointer',
  transition:     'box-shadow 0.15s',
  display:        'flex',
  flexDirection:  'column' as const,
  minWidth:       0,
}

const pillarHead: React.CSSProperties = {
  padding:        '18px 24px 14px',
  borderBottom:   `1px solid ${UX.borderSoft}`,
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'center',
  gap:            8,
}

const pillarHLabel: React.CSSProperties = {
  fontSize:      11,
  color:         UX.ink4,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  fontWeight:    500,
  whiteSpace:    'nowrap' as const,
}

const pillarStatus: React.CSSProperties = {
  fontSize:      10,
  padding:       '3px 9px',
  borderRadius:  999,
  fontWeight:    600,
  letterSpacing: '0.04em',
  whiteSpace:    'nowrap' as const,
}

const pillarBody: React.CSSProperties = {
  padding:    '18px 24px 22px',
  flex:       1,
  display:    'flex',
  flexDirection: 'column' as const,
}

const baRow: React.CSSProperties = {
  display:    'flex',
  alignItems: 'baseline',
  gap:        16,
  marginBottom: 8,
  flexWrap:   'wrap' as const,
}

const baCurrent: React.CSSProperties = {
  fontSize:      38,
  fontWeight:    700,
  color:         UX.ink1,
  letterSpacing: '-0.025em',
  lineHeight:    1,
}

const baArrow: React.CSSProperties = {
  fontSize:   22,
  color:      UX.ink4,
  fontWeight: 300,
}

const baProjected: React.CSSProperties = {
  fontSize:      38,
  fontWeight:    700,
  color:         UX.greenInk,
  letterSpacing: '-0.025em',
  lineHeight:    1,
}

const baSuffix: React.CSSProperties = {
  fontSize:   14,
  color:      UX.ink3,
  fontWeight: 500,
}

const pillarContext: React.CSSProperties = {
  fontSize:    13,
  color:       UX.ink3,
  lineHeight:  1.5,
  marginBottom: 16,
  margin:      '0 0 16px 0',
}

const pillarStrong: React.CSSProperties = {
  color:      UX.ink1,
  fontWeight: 700,
}

const pillarStats: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap:                 1,
  background:          UX.borderSoft,
  border:              `1px solid ${UX.borderSoft}`,
  borderRadius:        8,
  overflow:            'hidden' as const,
  marginBottom:        18,
}

const pillarStatCell: React.CSSProperties = {
  background: UX.cardBg,
  padding:    '12px 14px',
  minWidth:   0,
}

const pillarStatLabel: React.CSSProperties = {
  fontSize:      10,
  color:         UX.ink4,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  fontWeight:    500,
  marginBottom:  4,
}

const pillarStatValue: React.CSSProperties = {
  fontSize:      16,
  fontWeight:    700,
  color:         UX.ink1,
  letterSpacing: '-0.01em',
  whiteSpace:    'nowrap' as const,
  overflow:      'hidden' as const,
  textOverflow:  'ellipsis' as const,
}

const pillarCta: React.CSSProperties = {
  background:   UX.ink1,
  color:        'white',
  border:       'none',
  padding:      '11px 22px',
  borderRadius: 999,
  fontSize:     13,
  fontWeight:   600,
  cursor:       'pointer',
  fontFamily:   'inherit',
  display:      'inline-flex',
  alignItems:   'center',
  gap:          8,
  alignSelf:    'flex-start',
  marginTop:    'auto',
}

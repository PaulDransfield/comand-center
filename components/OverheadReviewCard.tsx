// components/OverheadReviewCard.tsx
//
// Dashboard hero-rail card mirroring the scheduling labour-savings card.
// Shows current vs projected net margin, the kr savings, and a CTA to
// /overheads/review.
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

const MONTHS_SHORT = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']

const cardLink: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column' as const,
  justifyContent: 'space-between',
  background:     UX.cardBg,
  border:         `1px solid ${UX.border}`,
  borderLeft:     `4px solid ${UX.greenInk}`,
  borderRadius:   UX.r_lg,
  padding:        '18px 20px',
  textDecoration: 'none',
  color:          'inherit',
  cursor:         'pointer',
  transition:     'box-shadow 0.15s',
}

const eyebrow: React.CSSProperties = {
  fontSize:      10,
  fontWeight:    500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color:         UX.ink4,
}

const cta: React.CSSProperties = {
  marginTop:    14,
  display:      'inline-flex',
  alignItems:   'center',
  gap:          6,
  color:        UX.greenInk,
  fontSize:     13,
  fontWeight:   500,
}

export function OverheadReviewCard({ data }: { data: ProjectionData }) {
  const periodLabel = `${MONTHS_SHORT[data.period.month - 1]} ${data.period.year}`
  const currentMargin   = Math.round(data.current.margin_pct)
  const projectedMargin = Math.round(data.projected.margin_pct)

  return (
    <a
      href="/overheads/review"
      style={cardLink}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
    >
      <div>
        <div style={eyebrow}>{periodLabel} · OVERHEADS REVIEW</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10, flexWrap: 'wrap' as const }}>
          <span style={{ fontSize: 26, fontWeight: 500, color: UX.ink2, letterSpacing: '-0.02em' }}>
            {currentMargin}%
          </span>
          <span style={{ fontSize: 18, color: UX.ink4 }}>→</span>
          <span style={{ fontSize: 26, fontWeight: 500, color: UX.greenInk, letterSpacing: '-0.02em' }}>
            {projectedMargin}%
          </span>
          <span style={{ fontSize: 12, color: UX.ink3, marginLeft: 2 }}>net margin</span>
        </div>
        <div style={{ fontSize: 12, color: UX.ink3, marginTop: 6, lineHeight: 1.4 }}>
          Your current overheads run <span style={{ color: UX.ink2, fontWeight: 500 }}>{fmtKr(data.current.overheads_sek)}</span>/mo. Cancelling{' '}
          <span style={{ color: UX.ink2, fontWeight: 500 }}>{data.pending_count}</span> flagged item{data.pending_count === 1 ? '' : 's'} brings them to{' '}
          <span style={{ color: UX.greenInk, fontWeight: 500 }}>{fmtKr(data.projected.overheads_sek)}</span>.
        </div>
        <div style={{ fontSize: 11, color: UX.ink4, marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${UX.borderSoft}` }}>
          Saves <span style={{ color: UX.greenInk, fontWeight: 500 }}>{fmtKr(data.savings.total_sek)}/mo</span> · {data.pending_count} flag{data.pending_count === 1 ? '' : 's'} pending
        </div>
      </div>
      <div style={cta}>Review overheads <span aria-hidden style={{ fontSize: 14 }}>→</span></div>
    </a>
  )
}

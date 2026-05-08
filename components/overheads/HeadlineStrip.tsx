'use client'
// components/overheads/HeadlineStrip.tsx
//
// Four-stat header for the overheads review page:
//   Total at stake / Price spikes / Reappeared / Decided last 90d
//
// Pure presentational. The page passes pre-computed numbers in — counts,
// sums and decided-last-90d come from /api/overheads/flags?stats=1 and
// client-side groupBy on the existing flag list.

import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtNum } from '@/lib/format'
import { useTranslations } from 'next-intl'

export interface HeadlineStripProps {
  totalSavings:           number          // sum of pending amount_sek
  supplierCount:          number          // unique (supplier, category) groups
  flagCount:              number          // total pending flags
  priceSpikeCount:        number
  priceSpikeSavings:      number
  reappearedCount:        number
  reappearedSavings:      number
  decidedLast90d:         number | null   // null = stats unavailable
  dismissedSavings90d:    number
}

export default function HeadlineStrip(props: HeadlineStripProps) {
  const t = useTranslations('overheads.review.headline')
  return (
    <div style={stripStyle}>
      <Cell isFirst>
        <Label>{t('totalAtStake')}</Label>
        <Value>{fmtKr(props.totalSavings)}<Suffix>/mo</Suffix></Value>
        <Meta>{t('totalAtStakeMeta', { suppliers: props.supplierCount, flags: props.flagCount })}</Meta>
      </Cell>

      <Cell>
        <Label>{t('priceSpikes')}</Label>
        <Value tone="red">{fmtNum(props.priceSpikeCount)}</Value>
        <Meta>{t('priceSpikesMeta', { amount: fmtKr(props.priceSpikeSavings) })}</Meta>
      </Cell>

      <Cell>
        <Label>{t('reappeared')}</Label>
        <Value tone="amber">{fmtNum(props.reappearedCount)}</Value>
        <Meta>{t('reappearedMeta', { amount: fmtKr(props.reappearedSavings) })}</Meta>
      </Cell>

      <Cell isNew>
        <Label>{t('decided90d')}</Label>
        <Value tone="green">{props.decidedLast90d == null ? '—' : fmtNum(props.decidedLast90d)}</Value>
        <Meta>{t('decided90dMeta', { amount: fmtKr(props.dismissedSavings90d) })}</Meta>
      </Cell>
    </div>
  )
}

const stripStyle: React.CSSProperties = {
  background:           UX.cardBg,
  border:               `1px solid ${UX.border}`,
  borderRadius:         UX.r_lg,
  padding:              '12px 22px',
  marginBottom:         14,
  display:              'grid',
  gridTemplateColumns:  '1.4fr 1fr 1fr 1fr',
  gap:                  24,
  alignItems:           'center',
}

function Cell({ children, isNew, isFirst }: { children: React.ReactNode; isNew?: boolean; isFirst?: boolean }) {
  return (
    <div className="cc-strip-cell" data-new={isNew ? 'true' : undefined} style={{
      borderLeft:  isFirst ? 'none' : `1px solid ${UX.borderSoft}`,
      paddingLeft: isFirst ? 0 : 24,
      position:    'relative',
    }}>
      {isNew && (
        <span style={{
          position: 'absolute', top: -2, right: 4,
          fontSize: 8, fontWeight: 700, color: UX.indigo,
          letterSpacing: '0.06em',
          background: UX.indigoBg, padding: '1px 5px',
          borderRadius: 999, border: `1px solid ${UX.border}`,
        }}>NEW</span>
      )}
      {children}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, color: UX.ink4, letterSpacing: '0.08em',
      textTransform: 'uppercase' as const, fontWeight: 500, marginBottom: 4,
    }}>
      {children}
    </div>
  )
}

function Value({ children, tone }: { children: React.ReactNode; tone?: 'red' | 'amber' | 'green' }) {
  const color =
    tone === 'red'   ? UX.redInk :
    tone === 'amber' ? UX.amberInk :
    tone === 'green' ? UX.greenInk : UX.ink1
  return (
    <div style={{
      fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em',
      lineHeight: 1, color, fontVariantNumeric: 'tabular-nums' as const,
    }}>
      {children}
    </div>
  )
}

function Suffix({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12, fontWeight: 500, color: UX.ink4, marginLeft: 4 }}>{children}</span>
}

function Meta({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: UX.ink4, marginTop: 4 }}>{children}</div>
}

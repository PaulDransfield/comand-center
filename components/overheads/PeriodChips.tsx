'use client'
// components/overheads/PeriodChips.tsx
//
// Period switcher above the invoice list. Clicking a chip refires the
// drilldown fetch for the chosen (year, month). All chips come from the
// supplier's flagged-period list — selecting one isn't an "open this
// period elsewhere" action, just "show invoices for this period in the
// inline drilldown."

import { UX } from '@/lib/constants/tokens'
import { useTranslations } from 'next-intl'

export interface PeriodKey { year: number; month: number }

interface Props {
  periods:   PeriodKey[]
  selected:  PeriodKey
  onSelect:  (p: PeriodKey) => void
}

export default function PeriodChips({ periods, selected, onSelect }: Props) {
  const t  = useTranslations('overheads.review.periodChips')
  const tM = useTranslations('overheads')
  const monthsShort: string[] = (tM.raw('months.short') as string[])
    ?? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  if (periods.length <= 1) return null

  return (
    <div style={{
      display:    'flex',
      gap:        6,
      flexWrap:   'wrap' as const,
      marginBottom: 14,
      alignItems: 'center',
    }}>
      <span style={{ fontSize: 12, color: UX.ink3, marginRight: 4 }}>{t('label')}</span>
      {periods.map(p => {
        const active = p.year === selected.year && p.month === selected.month
        return (
          <button
            key={`${p.year}-${p.month}`}
            type="button"
            onClick={() => onSelect(p)}
            style={{
              background:   active ? UX.ink1 : 'white',
              color:        active ? 'white'  : UX.ink3,
              border:       `1px solid ${active ? UX.ink1 : UX.border}`,
              padding:      '4px 10px',
              borderRadius: 999,
              fontSize:     11,
              fontWeight:   500,
              cursor:       'pointer',
              fontFamily:   'inherit',
            }}
          >
            {monthsShort[p.month - 1]} {p.year}
          </button>
        )
      })}
    </div>
  )
}

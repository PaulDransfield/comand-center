'use client'
// components/overheads/FlagListPane.tsx
//
// Left pane of the redesigned overheads-review page. Search + filter pills
// + sort indicator + scrollable list of supplier-grouped rows.
//
// Group "selection" is by `${supplier_name_normalised}::${category}` — the
// same grouping primitive the legacy page used. Clicking a row tells the
// parent which group is selected; the parent threads that into the detail
// pane.

import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import type { Flag, FlagGroup, FlagTypeFilter } from './types'

interface Props {
  groups:           FlagGroup[]            // already category-filtered, already grouped
  rawFlags:         Flag[]                 // ALL flags (pre-filter) — drives counts
  selectedKey:      string | null
  onSelect:         (key: string) => void

  search:           string
  onSearch:         (s: string) => void

  flagTypeFilter:   FlagTypeFilter
  onFlagType:       (t: FlagTypeFilter) => void

  includeResolved:  boolean
  onToggleResolved: () => void

  totalGroupCount:  number                 // groups before search filter — for "X of Y"
}

export default function FlagListPane(props: Props) {
  const t = useTranslations('overheads.review.list')
  const tF = useTranslations('overheads.review.filters')
  const tM = useTranslations('overheads')
  const monthsShort: string[] = (tM.raw('months.short') as string[])
    ?? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  // Filter-pill counts derived purely from rawFlags (so the active filter
  // doesn't hide the unread counts on the other pills).
  const counts = useMemo(() => {
    const byType: Record<string, Set<string>> = {}
    const all   = new Set<string>()
    for (const f of props.rawFlags) {
      const cat = f.category ?? 'other_cost'
      const key = `${f.supplier_name_normalised}::${cat}`
      all.add(key)
      const t = f.flag_type
      if (!byType[t]) byType[t] = new Set()
      byType[t].add(key)
    }
    return {
      all:                  all.size,
      price_spike:          byType['price_spike']?.size          ?? 0,
      dismissed_reappeared: byType['dismissed_reappeared']?.size ?? 0,
      new_supplier:         byType['new_supplier']?.size         ?? 0,
      one_off_high:         byType['one_off_high']?.size         ?? 0,
    }
  }, [props.rawFlags])

  // Filter rows further by the search box.
  const visibleGroups = useMemo(() => {
    if (!props.search.trim()) return props.groups
    const q = props.search.toLowerCase().trim()
    return props.groups.filter(g => g.latest.supplier_name.toLowerCase().includes(q))
  }, [props.groups, props.search])

  return (
    <div style={paneStyle}>
      <div style={headStyle}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="text"
            value={props.search}
            onChange={e => props.onSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            style={searchInputStyle}
          />
          <button
            type="button"
            onClick={props.onToggleResolved}
            title={t('resolvedToggleTitle')}
            style={resolvedToggleStyle(props.includeResolved)}
          >
            {props.includeResolved ? t('resolvedToggleOn') : t('resolvedToggleOff')}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const }}>
          <Pill active={props.flagTypeFilter === 'all'} onClick={() => props.onFlagType('all')}>
            {tF('all')} <Count>{counts.all}</Count>
          </Pill>
          <Pill active={props.flagTypeFilter === 'price_spike'} onClick={() => props.onFlagType('price_spike')} tone="red">
            {tF('spike')} <Count>{counts.price_spike}</Count>
          </Pill>
          <Pill active={props.flagTypeFilter === 'dismissed_reappeared'} onClick={() => props.onFlagType('dismissed_reappeared')} tone="amber">
            {tF('reappeared')} <Count>{counts.dismissed_reappeared}</Count>
          </Pill>
          <Pill active={props.flagTypeFilter === 'new_supplier'} onClick={() => props.onFlagType('new_supplier')} tone="info">
            {tF('newSupplier')} <Count>{counts.new_supplier}</Count>
          </Pill>
          <Pill active={props.flagTypeFilter === 'one_off_high'} onClick={() => props.onFlagType('one_off_high')} tone="purple">
            {tF('oneOff')} <Count>{counts.one_off_high}</Count>
          </Pill>
        </div>
      </div>

      <div style={sortBarStyle}>
        <span>{t('sortAtStake')}</span>
        <span>{t('counter', { shown: visibleGroups.length, total: props.totalGroupCount })}</span>
      </div>

      <div style={listBodyStyle}>
        {visibleGroups.length === 0 && (
          <div style={emptyStyle}>{t('emptyAfterFilter')}</div>
        )}
        {visibleGroups.map(g => (
          <Row
            key={g.key}
            group={g}
            selected={g.key === props.selectedKey}
            onClick={() => props.onSelect(g.key)}
            monthsShort={monthsShort}
          />
        ))}
      </div>
    </div>
  )
}

function Row({ group, selected, onClick, monthsShort }: {
  group:       FlagGroup
  selected:    boolean
  onClick:     () => void
  monthsShort: string[]
}) {
  const t  = useTranslations('overheads.review.row')
  const tT = useTranslations('overheads.review.flagTones')
  const f  = group.latest
  const periodLabel = `${monthsShort[f.period_month - 1]} ${f.period_year}`

  // Compute the badge tone + label.
  let toneClass: 'red' | 'amber' | 'info' | 'purple' | 'gray' = 'info'
  let label = ''
  if (f.flag_type === 'price_spike') {
    toneClass = 'red'
    const pct = f.prior_avg_sek
      ? Math.round(((f.amount_sek - f.prior_avg_sek) / f.prior_avg_sek) * 100)
      : 0
    label = tT('priceTpl', { sign: pct >= 0 ? '+' : '', pct })
  } else if (f.flag_type === 'dismissed_reappeared') {
    toneClass = 'amber'; label = tT('reappeared')
  } else if (f.flag_type === 'new_supplier') {
    toneClass = 'info';  label = tT('new')
  } else if (f.flag_type === 'one_off_high') {
    toneClass = 'purple'; label = tT('oneOff')
  } else {
    toneClass = 'gray';  label = tT('duplicate')
  }

  const isResolved = f.resolution_status !== 'pending'
  const periodCount = group.others.length + 1

  return (
    <div
      onClick={onClick}
      style={{
        padding:     '14px 16px',
        borderBottom:`1px solid ${UX.borderSoft}`,
        cursor:      'pointer',
        display:     'grid',
        gridTemplateColumns: '1fr auto',
        gap:         8,
        alignItems:  'center',
        background:  selected ? '#eaf3de' : 'white',
        borderLeft:  `3px solid ${selected ? UX.greenInk : 'transparent'}`,
        opacity:     isResolved ? 0.55 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: UX.ink1,
          whiteSpace: 'nowrap' as const, overflow: 'hidden' as const,
          textOverflow: 'ellipsis' as const, marginBottom: 4,
        }}>
          {f.supplier_name}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' as const }}>
          <BadgeMini tone={toneClass}>{label}</BadgeMini>
          <span style={{ fontSize: 10, color: UX.ink4 }}>{periodLabel}</span>
          <span style={{
            fontSize: 9, color: UX.ink4, marginLeft: 'auto',
            textTransform: 'uppercase' as const, letterSpacing: '0.05em', fontWeight: 500,
            padding: '1px 6px', background: UX.subtleBg,
            border: `1px solid ${UX.borderSoft}`, borderRadius: 3,
          }}>
            {f.category === 'food_cost' ? t('catFood') : t('catOther')}
          </span>
          {isResolved && (
            <BadgeMini tone="gray">{t('resolved')}</BadgeMini>
          )}
        </div>
      </div>
      <div style={{ textAlign: 'right' as const }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: UX.ink1, lineHeight: 1,
          whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' as const,
        }}>
          {fmtKr(f.amount_sek)}
        </div>
        <div style={{ fontSize: 10, color: UX.ink4, marginTop: 3 }}>{t('perMo')}</div>
        {periodCount > 1 && (
          <div style={{ fontSize: 9, color: UX.ink4, marginTop: 3, fontWeight: 500 }}>
            {t('plusPeriods', { count: periodCount - 1 })}
          </div>
        )}
      </div>
    </div>
  )
}

function Pill({ children, active, onClick, tone }: {
  children: React.ReactNode
  active:   boolean
  onClick:  () => void
  tone?:    'red' | 'amber' | 'info' | 'purple'
}) {
  const accentInk =
    tone === 'red'    ? UX.redInk :
    tone === 'amber'  ? UX.amberInk :
    tone === 'info'   ? UX.indigo :
    tone === 'purple' ? '#6b21a8' : UX.ink2
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background:   active ? UX.ink1 : '#e9eae5',
        border:       'none',
        padding:      '4px 10px',
        borderRadius: 999,
        fontSize:     11,
        fontWeight:   500,
        color:        active ? 'white' : accentInk,
        cursor:       'pointer',
        whiteSpace:   'nowrap' as const,
        fontFamily:   'inherit',
      }}
    >
      {children}
    </button>
  )
}

function Count({ children }: { children: React.ReactNode }) {
  return <span style={{ opacity: 0.6, marginLeft: 3 }}>{children}</span>
}

function BadgeMini({ children, tone }: { children: React.ReactNode; tone: 'red' | 'amber' | 'info' | 'purple' | 'gray' }) {
  const palette = TONE[tone]
  return (
    <span style={{
      fontSize: 9, fontWeight: 600, padding: '2px 6px',
      borderRadius: 999, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
      background: palette.bg, color: palette.fg,
    }}>{children}</span>
  )
}

const TONE: Record<'red' | 'amber' | 'info' | 'purple' | 'gray', { bg: string; fg: string }> = {
  red:    { bg: '#fceeea', fg: '#b8412e' },
  amber:  { bg: '#fbeede', fg: '#c46a18' },
  info:   { bg: '#ebf2f8', fg: '#3a6f9a' },
  purple: { bg: '#f1ebf8', fg: '#6b4a8a' },
  gray:   { bg: '#e9eae5', fg: UX.ink3 },
}

const paneStyle: React.CSSProperties = {
  background:    UX.cardBg,
  border:        `1px solid ${UX.border}`,
  borderRadius:  UX.r_lg,
  overflow:      'hidden',
  display:       'flex',
  flexDirection: 'column',
}

const headStyle: React.CSSProperties = {
  padding:        '12px 16px',
  borderBottom:   `1px solid ${UX.borderSoft}`,
  display:        'flex',
  flexDirection:  'column',
  gap:            8,
}

const searchInputStyle: React.CSSProperties = {
  background:   '#f3f4f0',
  border:       `1px solid ${UX.borderSoft}`,
  borderRadius: 8,
  padding:      '7px 12px',
  fontSize:     13,
  color:        UX.ink2,
  flex:         1,
  fontFamily:   'inherit',
  outline:      'none',
}

function resolvedToggleStyle(active: boolean): React.CSSProperties {
  return {
    background:   active ? UX.ink1 : '#f3f4f0',
    color:        active ? 'white' : UX.ink3,
    border:       `1px solid ${UX.borderSoft}`,
    padding:      '6px 10px',
    borderRadius: 8,
    fontSize:     11,
    cursor:       'pointer',
    fontFamily:   'inherit',
    fontWeight:   500,
    whiteSpace:   'nowrap',
  }
}

const sortBarStyle: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  fontSize:       10,
  color:          UX.ink4,
  textTransform:  'uppercase' as const,
  letterSpacing:  '0.06em',
  padding:        '8px 16px',
  background:     UX.subtleBg,
  borderBottom:   `1px solid ${UX.borderSoft}`,
  fontWeight:     500,
}

const listBodyStyle: React.CSSProperties = {
  overflowY: 'auto',
  flex:      1,
}

const emptyStyle: React.CSSProperties = {
  padding:    '32px 16px',
  textAlign:  'center' as const,
  color:      UX.ink4,
  fontSize:   12,
}

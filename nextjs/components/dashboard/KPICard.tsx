// @ts-nocheck
// components/dashboard/KPICard.tsx
//
// A KPI CARD â€” shows one financial metric.
// Used in the dashboard for: Revenue, Margin, Staff %, Food %, Rent %, Profit.
//
// Props:
//   label       â€” "Staff Cost"
//   value       â€” formatted value to display: "224 978 kr" or "44.5%"
//   delta       â€” change vs last month: "+9.6%" (green if positive, red if negative)
//   target      â€” the target percentage (e.g. 40 for staff cost)
//   actual      â€” the actual percentage (e.g. 44.5)
//   overIsGood  â€” false for cost metrics (over target = red), true for revenue/margin
//   sub         â€” small subtitle text: "of revenue Â· target 40%"

'use client'

interface KPICardProps {
  label:       string
  value:       string
  delta?:      string    // e.g. "+9.6%"
  deltaGood?:  boolean   // is a positive delta good? (true for revenue, false for cost)
  target?:     number    // target percentage 0-100
  actual?:     number    // actual percentage 0-100
  overIsGood?: boolean   // for margin: being OVER target is good
  sub?:        string
  accent?:     string    // left border colour
}

export default function KPICard({
  label, value, delta, deltaGood = true,
  target, actual, overIsGood = false,
  sub, accent,
}: KPICardProps) {
  // Determine whether actual vs target is good or bad
  let barColour = 'var(--green)'
  let statusText = ''

  if (target !== undefined && actual !== undefined) {
    const overTarget = actual > target
    const isGood = overIsGood ? overTarget : !overTarget

    if (isGood) {
      barColour  = 'var(--green)'
      statusText = overIsGood
        ? (overTarget ? 'â†‘ above target' : 'â†“ below target')
        : (overTarget ? 'â†‘ over target'  : 'âœ“ on target')
    } else {
      barColour  = actual > target * 1.1 ? 'var(--red)' : 'var(--amber)'
      statusText = overIsGood
        ? 'â†“ below target'
        : `+${(actual - target).toFixed(1)}pp over target`
    }
  }

  // Delta colour
  const deltaColour = delta
    ? (delta.startsWith('+') === deltaGood ? 'var(--green)' : 'var(--red)')
    : 'var(--ink-4)'

  // Bar fill percentage (cap at 100% for display)
  const barPct = target && actual ? Math.min(100, Math.round(actual / target * 100)) : 0

  return (
    <div style={{ ...S.card, ...(accent ? { borderLeft: `3px solid ${accent}` } : {}) }}>
      {/* Label */}
      <div style={S.label}>{label}</div>

      {/* Main value + delta */}
      <div style={S.row}>
        <div style={S.value}>{value}</div>
        {delta && (
          <span style={{ ...S.delta, color: deltaColour }}>
            {delta}
          </span>
        )}
      </div>

      {/* Progress bar vs target */}
      {target !== undefined && actual !== undefined && (
        <div style={S.barWrap}>
          <div style={S.barTrack}>
            <div style={{ ...S.barFill, width: `${barPct}%`, background: barColour }} />
            {/* Target marker at 100% of target */}
            <div style={S.targetLine} title={`Target: ${target}%`} />
          </div>
        </div>
      )}

      {/* Status / sub text */}
      {(statusText || sub) && (
        <div style={S.sub}>{statusText || sub}</div>
      )}
    </div>
  )
}

// Usage meter â€” shows tokens, documents etc as a simple bar
// Exported separately so dashboard can show plan limits
export function UsageMeter({
  label, used, limit, unit = '',
}: {
  label: string
  used:  number
  limit: number
  unit?: string
}) {
  const pct      = limit > 0 ? Math.min(100, Math.round(used / limit * 100)) : 0
  const nearLimit = pct >= 80
  const atLimit   = used >= limit

  return (
    <div style={{ ...S.card, padding: '10px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={S.label}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: atLimit ? 'var(--red)' : 'var(--ink-4)' }}>
          {used.toLocaleString()}{unit} / {limit === Infinity ? 'âˆž' : limit.toLocaleString()}{unit}
        </span>
      </div>
      <div style={S.barTrack}>
        <div style={{
          ...S.barFill,
          width:      `${pct}%`,
          background: atLimit ? 'var(--red)' : nearLimit ? 'var(--amber)' : 'var(--green)',
        }} />
      </div>
      {nearLimit && !atLimit && (
        <div style={{ ...S.sub, color: 'var(--amber)', marginTop: 4 }}>Approaching limit</div>
      )}
      {atLimit && (
        <div style={{ ...S.sub, color: 'var(--red)', marginTop: 4 }}>Limit reached â€” upgrade to continue</div>
      )}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  card: {
    background:   'var(--white)',
    border:       '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding:      '14px 16px',
  },
  label: {
    fontSize:      10,
    fontWeight:    700,
    textTransform: 'uppercase' as const,
    letterSpacing: '.09em',
    color:         'var(--ink-4)',
    marginBottom:  6,
  },
  row: {
    display:    'flex',
    alignItems: 'baseline',
    gap:        8,
    marginBottom: 8,
  },
  value: {
    fontFamily: 'var(--display)',
    fontSize:   26,
    fontWeight: 600,
    color:      'var(--ink)',
    lineHeight: 1,
  },
  delta: {
    fontSize:   11,
    fontWeight: 700,
    fontFamily: 'var(--mono)',
  },
  barWrap: { marginBottom: 4 },
  barTrack: {
    height:       5,
    background:   'var(--border)',
    borderRadius: 3,
    overflow:     'hidden',
    position:     'relative' as const,
  },
  barFill: {
    height:       '100%',
    borderRadius: 3,
    transition:   'width .5s ease',
  },
  targetLine: {
    position:   'absolute' as const,
    right:      0,
    top:        0,
    bottom:     0,
    width:      '2px',
    background: 'var(--border-d)',
  },
  sub: {
    fontSize:  10,
    color:     'var(--ink-4)',
    marginTop: 3,
  },
}

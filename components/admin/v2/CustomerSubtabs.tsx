'use client'
// components/admin/v2/CustomerSubtabs.tsx
//
// Sub-tab nav for the customer-detail page. 8 tabs per the plan.
// PR 4 implements Snapshot, Integrations, Data. Others render a
// "Coming in PR 5" placeholder; the disabled flag visually mutes them
// but they're still clickable so the user can see the planned shape.

export type SubTab =
  | 'snapshot'
  | 'integrations'
  | 'data'
  | 'billing'
  | 'users'
  | 'sync_history'
  | 'notes'
  | 'audit'
  | 'danger'

// All sub-tabs ship live as of PR 10 (Notes added). The `pr` field is kept
// for posterity in case we need to revert to a "coming soon" treatment later.
const TABS: Array<{ key: SubTab; label: string; pr: number }> = [
  { key: 'snapshot',     label: 'Snapshot',      pr: 4 },
  { key: 'integrations', label: 'Integrations',  pr: 4 },
  { key: 'data',         label: 'Data',          pr: 4 },
  { key: 'billing',      label: 'Billing',       pr: 5 },
  { key: 'users',        label: 'Users',         pr: 5 },
  { key: 'sync_history', label: 'Sync history',  pr: 5 },
  { key: 'notes',        label: 'Notes',         pr: 10 },
  { key: 'audit',        label: 'Audit',         pr: 5 },
  { key: 'danger',       label: 'Danger zone',   pr: 5 },
]
// The "future" treatment below now triggers only for tabs at PR>10 (none).
const FUTURE_PR_THRESHOLD = 10

export function CustomerSubtabs({ active, onChange }: { active: SubTab; onChange: (t: SubTab) => void }) {
  return (
    <div style={{
      display:      'flex',
      gap:          0,
      borderBottom: '1px solid #e5e7eb',
      marginBottom: 16,
      overflowX:    'auto' as const,
    }}>
      {TABS.map(t => {
        const isActive = active === t.key
        const isFuture = t.pr > FUTURE_PR_THRESHOLD
        const isDanger = t.key === 'danger'
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            title={isFuture ? `Coming in PR ${t.pr}` : undefined}
            style={{
              padding:        '10px 14px',
              border:         'none',
              background:     'transparent',
              borderBottom:   isActive ? `2px solid ${isDanger ? '#dc2626' : '#1a1f2e'}` : '2px solid transparent',
              fontSize:       13,
              fontWeight:     isActive ? 600 : 500,
              color:          isActive
                ? (isDanger ? '#dc2626' : '#111')
                : (isFuture ? '#d1d5db' : (isDanger ? '#b91c1c' : '#6b7280')),
              cursor:         'pointer',
              whiteSpace:     'nowrap' as const,
              transition:     'color 0.15s, border-color 0.15s',
            }}
          >
            {t.label}
            {isFuture && (
              <span style={{ marginLeft: 5, fontSize: 9, fontWeight: 700, color: '#9ca3af' }}>PR{t.pr}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export const CUSTOMER_SUBTABS = TABS

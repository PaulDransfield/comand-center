// components/AiUsageBanner.tsx
//
// Site-wide sticky banner that warns the operator when AI usage is
// approaching daily (50%, 80%) or monthly (70%, 90%) thresholds.
// Rendered at the top of the main content column by AppShell.
//
// Behaviour:
//   - Polls /api/me/usage on mount + every 2 min + on window focus
//   - Info severity  (50%/70%) — blue banner, dismissible for the session
//   - Warn severity  (80%/90%) — amber banner, dismissible but re-shows every
//     page load (too important to hide across navigations)
//   - Blocked state  — red banner, not dismissible
//   - No banner if usage < 50% and no block

'use client'

import { useEffect, useRef, useState } from 'react'

type UsageState = {
  authenticated: boolean
  orgId?:  string | null
  plan?:   string
  blocked?: boolean
  reason?:  string
  used?:    number
  limit?:   number
  monthly_used_sek?:    number
  monthly_ceiling_sek?: number
  warning?: {
    used:     number
    limit:    number
    percent:  number
    severity: 'info' | 'warn'
  } | null
  monthly_warning?: {
    used_sek:    number
    ceiling_sek: number
    percent:     number
    severity:    'info' | 'warn'
  } | null
}

const STORAGE_KEY = 'cc_ai_usage_banner_dismissed'

function getDismissedThisSession(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return new Set(raw ? JSON.parse(raw) : [])
  } catch { return new Set() }
}

function saveDismissed(keys: Set<string>) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keys))) } catch {}
}

export default function AiUsageBanner() {
  const [state,     setState]     = useState<UsageState | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(() => getDismissedThisSession())
  const timerRef = useRef<any>(null)

  async function fetchUsage() {
    try {
      const r = await fetch('/api/me/usage')
      if (r.status === 401) { setState(null); return }
      const j = await r.json()
      setState(j)
    } catch { /* non-fatal */ }
  }

  useEffect(() => {
    fetchUsage()
    timerRef.current = setInterval(fetchUsage, 2 * 60_000)
    const onFocus = () => fetchUsage()
    window.addEventListener('focus', onFocus)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!state || !state.authenticated) return null

  // Blocked — always show, never dismissible.
  if (state.blocked) {
    const msg = state.reason === 'monthly_ceiling'
      ? 'AI paused — monthly cost ceiling reached. Contact support to review.'
      : state.reason === 'global_kill_switch'
      ? 'AI temporarily paused across CommandCenter. Try again shortly.'
      : 'AI limit reached for today. Resets at midnight Stockholm time.'
    return <Bar color="red" text={msg} href="/upgrade?focus=ai" cta="Upgrade" />
  }

  // Pick the most urgent active warning (warn > info, monthly > daily when tied).
  const candidates: Array<{ key: string; severity: 'info'|'warn'; text: string; cta: string }> = []
  if (state.monthly_warning) {
    const m = state.monthly_warning
    candidates.push({
      key:      `monthly_${m.severity}_${Math.floor(m.percent / 10)}`,
      severity: m.severity,
      text:     `${m.percent}% of this month's AI budget used (${Math.round(m.used_sek)} of ${Math.round(m.ceiling_sek)} SEK).`,
      cta:      m.severity === 'warn' ? 'Review usage' : 'Details',
    })
  }
  if (state.warning) {
    const w = state.warning
    candidates.push({
      key:      `daily_${w.severity}_${Math.floor(w.percent / 10)}`,
      severity: w.severity,
      text:     `You've used ${w.percent}% of today's AI quota (${w.used} of ${w.limit}).`,
      cta:      w.severity === 'warn' ? 'Upgrade' : 'Details',
    })
  }

  if (!candidates.length) return null

  // Warn beats info; monthly beats daily at same severity.
  candidates.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warn' ? -1 : 1
    return a.key.startsWith('monthly_') ? -1 : 1
  })
  const pick = candidates[0]

  // Info is dismissible for the session; warn re-shows on page load but can be
  // dismissed per-page to keep the UI usable.
  if (dismissed.has(pick.key)) return null

  function dismiss() {
    const next = new Set(dismissed); next.add(pick.key); setDismissed(next); saveDismissed(next)
  }

  return (
    <Bar
      color={pick.severity === 'warn' ? 'amber' : 'blue'}
      text={pick.text}
      href="/upgrade?focus=ai"
      cta={pick.cta}
      onDismiss={dismiss}
    />
  )
}

function Bar({ color, text, href, cta, onDismiss }: {
  color:    'blue' | 'amber' | 'red'
  text:     string
  href:     string
  cta:      string
  onDismiss?: () => void
}) {
  const palette = {
    blue:  { bg: '#eef2ff', border: '#c7d2fe', text: '#3730a3', cta: '#4338ca' },
    amber: { bg: '#fffbeb', border: '#fde68a', text: '#78350f', cta: '#b45309' },
    red:   { bg: '#fef2f2', border: '#fecaca', text: '#991b1b', cta: '#b91c1c' },
  }[color]
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '8px 14px',
      background: palette.bg,
      borderBottom: `1px solid ${palette.border}`,
      fontSize: 13, color: palette.text,
    }}>
      <span style={{ flex: 1, minWidth: 0 }}>{text}</span>
      <a href={href} style={{ color: palette.cta, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}>
        {cta} →
      </a>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: palette.text, fontSize: 16, lineHeight: 1, padding: '0 4px' }}>
          ×
        </button>
      )}
    </div>
  )
}

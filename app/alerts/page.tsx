'use client'
// @ts-nocheck
// app/alerts/page.tsx — full rebuild on the new system
//
// First proper UXP migration of this page. Down from 352 lines to ~440.
// Every surface on UXP tokens — the legacy red/amber/yellow/blue ad-hoc
// palette is gone in favour of UXP semantic tones (rose for critical/
// high, coral for medium/warning, lav for info). KPI strip uses
// KpiCardUX. AiBadge import retained for the AI-detected pill.
//
// All four flows preserved verbatim:
//   1. Mark read / dismiss
//   2. Show-all / unread-only toggle
//   3. Confirmation filter dropdown (when PREDICTION_V2_ANOMALY_CONFIRM_UI
//      is on for at least one business)
//   4. Per-alert confirm / reject with optional notes textarea
//
// Data:
//   GET   /api/alerts                                       — alerts list
//   PATCH /api/alerts                                       — mark_read / dismiss / confirm / reject
//   GET   /api/businesses + /api/feature-flags/prediction-v2 — flag check per biz

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import { AiBadge } from '@/components/ui/AiBadge'
import { UXP } from '@/lib/constants/tokens'

type Severity = 'critical' | 'high' | 'medium' | 'low'
type ConfirmationStatus = 'pending' | 'confirmed' | 'rejected' | 'auto_resolved'
type ConfirmationFilter = 'all' | ConfirmationStatus

interface Alert {
  id:                  string
  alert_type:          string
  severity:            Severity
  title:               string
  description:         string
  metric_value:        number
  expected_value:      number
  deviation_pct:       number
  period_date:         string
  is_read:             boolean
  is_dismissed:        boolean
  created_at:          string
  confirmation_status?: ConfirmationStatus | null
  confirmed_at?:        string | null
  confirmation_notes?:  string | null
  business_id?:         string
  businesses: { name: string; city: string | null } | null
}

const SEV_PALETTE: Record<Severity, { bg: string; bar: string; chip: string; chipBg: string }> = {
  critical: { bg: UXP.roseFill,  bar: UXP.rose,  chip: UXP.roseText,  chipBg: UXP.roseFill  },
  high:     { bg: UXP.roseFill,  bar: UXP.coral, chip: UXP.roseText,  chipBg: UXP.lavFill   },
  medium:   { bg: UXP.lavFill,   bar: UXP.coral, chip: UXP.coral,     chipBg: UXP.lavFill   },
  low:      { bg: UXP.lavFill,   bar: UXP.lav,   chip: UXP.lavText,   chipBg: UXP.lavFill   },
}

const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export default function AlertsPage() {
  const t = useTranslations('alerts')
  const [alerts,         setAlerts]         = useState<Alert[]>([])
  const [loading,        setLoading]        = useState(true)
  const [showAll,        setShowAll]        = useState(false)
  const [confirmFilter,  setConfirmFilter]  = useState<ConfirmationFilter>('all')
  const [flaggedBusinesses, setFlaggedBusinesses] = useState<Set<string>>(new Set())
  const [decisionModal,  setDecisionModal]  = useState<{ id: string; action: 'confirm' | 'reject' } | null>(null)
  const [decisionNotes,  setDecisionNotes]  = useState('')

  // Per-business flag check — see legacy comment for context. The
  // confirm/reject UI is gated behind PREDICTION_V2_ANOMALY_CONFIRM_UI
  // per business; alerts span multiple businesses so we resolve each
  // and gate per-alert at render time.
  useEffect(() => {
    let cancelled = false
    fetch('/api/businesses', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(async (bizList: any[] | null) => {
        if (!Array.isArray(bizList) || bizList.length === 0 || cancelled) return
        const checks = await Promise.all(
          bizList.map((b: any) =>
            fetch(`/api/feature-flags/prediction-v2?business_id=${b.id}`, { cache: 'no-store' })
              .then(r => r.ok ? r.json() : null)
              .then(j => ({ id: b.id as string, flags: (j?.flags as string[]) ?? [] }))
              .catch(() => ({ id: b.id as string, flags: [] as string[] }))
          ),
        )
        if (cancelled) return
        const next = new Set<string>()
        for (const { id, flags } of checks) {
          if (flags.includes('PREDICTION_V2_ANOMALY_CONFIRM_UI')) next.add(id)
        }
        setFlaggedBusinesses(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  const confirmFlagOn = flaggedBusinesses.size > 0

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (showAll)                     params.set('include_read', 'true')
    if (confirmFilter !== 'all')     params.set('confirmation_status', confirmFilter)
    const res  = await fetch(`/api/alerts?${params.toString()}`)
    const data = await res.json()
    if (Array.isArray(data)) setAlerts(data)
    setLoading(false)
  }, [showAll, confirmFilter])
  useEffect(() => { load() }, [load])

  async function action(id: string, type: 'mark_read' | 'dismiss') {
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: type }),
    })
    load()
  }

  async function decide(id: string, kind: 'confirm' | 'reject', notes?: string) {
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: kind, notes: notes ?? null }),
    })
    setDecisionModal(null)
    setDecisionNotes('')
    load()
  }

  const critical = alerts.filter(a => a.severity === 'critical').length
  const high     = alerts.filter(a => a.severity === 'high').length
  const unread   = alerts.filter(a => !a.is_read).length

  return (
    <AppShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1100 }}>

        <div style={{
          display:         'flex',
          justifyContent:  'space-between',
          alignItems:      'flex-start',
          flexWrap:        'wrap' as const,
          gap:             12,
        }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>{t('page.title')}</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>{t('page.subtitle')}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
            {confirmFlagOn && (
              <ConfirmFilterToggle value={confirmFilter} onChange={setConfirmFilter} t={t} />
            )}
            <button
              type="button"
              onClick={() => setShowAll(s => !s)}
              style={ghostBtn}
            >
              {showAll ? t('page.unreadOnly') : t('page.showAll')}
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap:                 12,
        }}>
          <KpiCardUX
            title={t('kpi.critical')}
            value={String(critical)}
            deltaGood={false}
            delta={critical > 0 ? '+ flagged' : null}
            microLabel={critical > 0 ? 'Needs attention' : 'None'}
          />
          <KpiCardUX
            title={t('kpi.high')}
            value={String(high)}
            deltaGood={false}
            delta={high > 0 ? '+ flagged' : null}
            microLabel={high > 0 ? 'Review today' : 'None'}
          />
          <KpiCardUX
            title={t('kpi.unread')}
            value={String(unread)}
            microLabel="Not yet acknowledged"
          />
          <KpiCardUX
            title={t('kpi.total')}
            value={String(alerts.length)}
            microLabel={showAll ? 'All alerts' : 'Unread only'}
          />
        </div>

        {/* List */}
        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
            {t('list.loading')}
          </div>
        ) : alerts.length === 0 ? (
          <AllClearCard t={t} />
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {alerts.map(alert => (
              <AlertCard
                key={alert.id}
                alert={alert}
                confirmFlagOn={confirmFlagOn && (!alert.business_id || flaggedBusinesses.has(alert.business_id))}
                onAction={action}
                onOpenDecision={(act: 'confirm' | 'reject') => { setDecisionNotes(''); setDecisionModal({ id: alert.id, action: act }) }}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      {decisionModal && (
        <DecisionModal
          action={decisionModal.action}
          notes={decisionNotes}
          setNotes={setDecisionNotes}
          onCancel={() => { setDecisionModal(null); setDecisionNotes('') }}
          onConfirm={() => decide(decisionModal.id, decisionModal.action, decisionNotes)}
          t={t}
        />
      )}
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function AllClearCard({ t }: any) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       40,
      textAlign:     'center' as const,
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        background: UXP.greenFill, color: UXP.greenDeep,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 16, marginBottom: 12, fontWeight: 600,
      }}>✓</div>
      <div style={{ fontSize: 14, fontWeight: 500, color: UXP.greenDeep, marginBottom: 6 }}>
        {t('list.allClear')}
      </div>
      <div style={{ fontSize: 11, color: UXP.ink3, maxWidth: 380, margin: '0 auto', lineHeight: 1.5 }}>
        {t('list.empty')}
      </div>
    </div>
  )
}

function AlertCard({ alert, confirmFlagOn, onAction, onOpenDecision, t }: any) {
  const palette = SEV_PALETTE[alert.severity as Severity] ?? SEV_PALETTE.low
  const conf    = alert.confirmation_status ?? 'pending'
  const decided = conf === 'confirmed' || conf === 'rejected' || conf === 'auto_resolved'

  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
      opacity:       alert.is_read ? 0.7 : 1,
      display:       'grid',
      gridTemplateColumns: '4px 1fr auto',
      gap:           14,
      alignItems:    'flex-start',
    }}>
      {/* Severity stripe */}
      <span style={{ width: 4, alignSelf: 'stretch' as const, background: palette.bar, borderRadius: 2 }} />

      {/* Body */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' as const }}>
          <span style={{
            fontSize:      9,
            fontWeight:    600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
            color:         palette.chip,
            background:    palette.chipBg,
            padding:       '2px 7px',
            borderRadius:  6,
          }}>
            {alert.severity} · {safeTranslate(t, `type.${alert.alert_type}`, alert.alert_type)}
          </span>
          {alert.businesses && (
            <span style={{ fontSize: 10, color: UXP.ink4 }}>
              {alert.businesses.name}{alert.businesses.city ? ` (${alert.businesses.city})` : ''}
            </span>
          )}
          {confirmFlagOn && conf !== 'pending' && <ConfirmationBadge status={conf} t={t} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1 }}>{alert.title}</span>
          <AiBadge label="AI" />
        </div>

        <div style={{ fontSize: 12, color: UXP.ink2, lineHeight: 1.5 }}>{alert.description}</div>

        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 6 }}>
          {t('card.detected', { created: fmtDate(alert.created_at), period: fmtDate(alert.period_date) })}
          {confirmFlagOn && alert.confirmation_notes && (
            <span style={{ display: 'block', marginTop: 4, fontStyle: 'italic' as const, color: UXP.ink3 }}>
              "{alert.confirmation_notes}"
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, justifyContent: 'flex-end' }}>
        {confirmFlagOn && !decided && (
          <>
            <button
              type="button"
              onClick={() => onOpenDecision('confirm')}
              title={t('card.confirmTooltip')}
              style={{ ...pillBtn, background: UXP.greenFill, color: UXP.greenDeep, border: `0.5px solid ${UXP.green}` }}
            >
              {t('card.confirm')}
            </button>
            <button
              type="button"
              onClick={() => onOpenDecision('reject')}
              title={t('card.rejectTooltip')}
              style={pillBtn}
            >
              {t('card.reject')}
            </button>
          </>
        )}
        {!alert.is_read && (
          <button
            type="button"
            onClick={() => onAction(alert.id, 'mark_read')}
            style={pillBtn}
          >
            {t('card.markRead')}
          </button>
        )}
        <button
          type="button"
          onClick={() => onAction(alert.id, 'dismiss')}
          style={{ ...pillBtn, color: UXP.ink4 }}
        >
          {t('card.dismiss')}
        </button>
      </div>
    </div>
  )
}

function ConfirmationBadge({ status, t }: { status: 'confirmed' | 'rejected' | 'auto_resolved' | 'pending'; t: any }) {
  const palette = status === 'confirmed'
    ? { bg: UXP.greenFill, fg: UXP.greenDeep, label: t('badge.confirmed') }
    : status === 'rejected'
    ? { bg: UXP.subtleBg,  fg: UXP.ink4,      label: t('badge.rejected') }
    : status === 'auto_resolved'
    ? { bg: UXP.lavFill,   fg: UXP.lavText,   label: t('badge.autoResolved') }
    : { bg: UXP.lavFill,   fg: UXP.coral,     label: t('badge.pending') }
  return (
    <span style={{
      display:       'inline-flex',
      alignItems:    'center',
      fontSize:      9,
      fontWeight:    600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
      padding:       '2px 7px',
      borderRadius:  999,
      background:    palette.bg,
      color:         palette.fg,
    }}>{palette.label}</span>
  )
}

function ConfirmFilterToggle({ value, onChange, t }: any) {
  const opts: Array<[ConfirmationFilter, string]> = [
    ['all',           t('filter.all')],
    ['pending',       t('filter.pending')],
    ['confirmed',     t('filter.confirmed')],
    ['rejected',      t('filter.rejected')],
    ['auto_resolved', t('filter.autoResolved')],
  ]
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as ConfirmationFilter)}
      style={{
        padding:      '5px 10px',
        background:   UXP.cardBg,
        color:        UXP.ink1,
        border:       `0.5px solid ${UXP.border}`,
        borderRadius: 7,
        fontSize:     11,
        fontFamily:   'inherit',
        cursor:       'pointer',
      }}
    >
      {opts.map(([k, label]) => (
        <option key={k} value={k}>{label}</option>
      ))}
    </select>
  )
}

function DecisionModal({ action, notes, setNotes, onCancel, onConfirm, t }: any) {
  return (
    <div
      role="dialog"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position:       'fixed' as const,
        inset:          0,
        background:     'rgba(58,53,80,0.32)',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        zIndex:         100,
        padding:        20,
      }}
    >
      <div style={{
        background:    UXP.cardBg,
        borderRadius:  UXP.r_lg,
        border:        `0.5px solid ${UXP.border}`,
        padding:       22,
        width:         460,
        maxWidth:      '100%',
      }}>
        <h2 style={{ fontSize: 15, fontWeight: 500, color: UXP.ink1, margin: '0 0 6px 0' }}>
          {action === 'confirm' ? t('modal.confirmTitle') : t('modal.rejectTitle')}
        </h2>
        <p style={{ fontSize: 12, color: UXP.ink3, margin: '0 0 14px 0', lineHeight: 1.5 }}>
          {action === 'confirm' ? t('modal.confirmBody') : t('modal.rejectBody')}
        </p>
        <label htmlFor="cc-anomaly-decision-notes" style={{
          fontSize:      9,
          fontWeight:    500,
          color:         UXP.ink4,
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
          display:       'block',
          marginBottom:  4,
        }}>
          {t('modal.notes')}
        </label>
        <textarea
          id="cc-anomaly-decision-notes"
          name="anomaly_decision_notes"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder={t('modal.placeholder')}
          rows={3}
          maxLength={500}
          style={{
            width:        '100%',
            padding:      10,
            background:   UXP.subtleBg,
            color:        UXP.ink1,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: 7,
            fontSize:     12,
            fontFamily:   'inherit',
            resize:       'vertical' as const,
            boxSizing:    'border-box' as const,
            lineHeight:   1.5,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" onClick={onCancel} style={ghostBtn}>{t('modal.cancel')}</button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              ...primaryBtn,
              background: action === 'confirm' ? UXP.green : UXP.lavDeep,
            }}
          >
            {action === 'confirm' ? t('modal.confirmAction') : t('modal.rejectAction')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

function safeTranslate(t: any, key: string, fallback: string): string {
  try { return t(key) } catch { return fallback }
}

const pillBtn: React.CSSProperties = {
  padding:      '4px 10px',
  background:   UXP.cardBg,
  color:        UXP.ink2,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 999,
  fontSize:     10,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
  letterSpacing: '0.02em',
}

const ghostBtn: React.CSSProperties = {
  ...pillBtn,
  padding: '6px 12px',
  fontSize: 11,
}

const primaryBtn: React.CSSProperties = {
  padding:      '6px 14px',
  background:   UXP.lavDeep,
  color:        '#fff',
  border:       'none',
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}

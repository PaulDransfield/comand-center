'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { AiBadge } from '@/components/ui/AiBadge'

interface Alert {
  id: string; alert_type: string; severity: string; title: string
  description: string; metric_value: number; expected_value: number
  deviation_pct: number; period_date: string; is_read: boolean
  is_dismissed: boolean; created_at: string
  // Piece 0 / M053 — confirmation workflow on the alert. Pre-migration
  // rows have null; post-migration default is 'pending'. The confirm/
  // reject buttons + status badge + filter dropdown render conditionally
  // on PREDICTION_V2_ANOMALY_CONFIRM_UI being on for the active business.
  confirmation_status?: 'pending' | 'confirmed' | 'rejected' | 'auto_resolved' | null
  confirmed_at?:        string | null
  confirmation_notes?:  string | null
  business_id?:         string
  businesses: { name: string; city: string | null } | null
}

const SEV: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  critical: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b', dot: '#dc2626' },
  high:     { bg: '#fff7ed', border: '#fed7aa', text: '#9a3412', dot: '#ea580c' },
  medium:   { bg: '#fefce8', border: '#fde68a', text: '#854d0e', dot: '#ca8a04' },
  low:      { bg: '#f0f9ff', border: '#bae6fd', text: '#075985', dot: '#0284c7' },
}

const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

type ConfirmationFilter = 'all' | 'pending' | 'confirmed' | 'rejected' | 'auto_resolved'

export default function AlertsPage() {
  const t = useTranslations('alerts')
  const [alerts,  setAlerts]   = useState<Alert[]>([])
  const [loading, setLoading]  = useState(true)
  const [showAll, setShowAll]  = useState(false)
  const [confirmFilter, setConfirmFilter] = useState<ConfirmationFilter>('all')

  // Per-business flag check — Piece 0 (D.4). The confirm/reject UI is
  // gated behind PREDICTION_V2_ANOMALY_CONFIRM_UI; default OFF. We
  // resolve it once on mount for the currently-selected business in the
  // sidebar, then show/hide the workflow accordingly.
  const [confirmFlagOn, setConfirmFlagOn] = useState(false)
  useEffect(() => {
    const bizId = typeof window !== 'undefined' ? localStorage.getItem('cc_selected_biz') : null
    if (!bizId) return
    fetch(`/api/feature-flags/prediction-v2?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (j?.flags?.includes?.('PREDICTION_V2_ANOMALY_CONFIRM_UI')) setConfirmFlagOn(true)
      })
      .catch(() => { /* fail closed — leave the flag off */ })
  }, [])

  // Notes modal state for confirm/reject
  const [decisionModal, setDecisionModal] = useState<{ id: string; action: 'confirm' | 'reject' } | null>(null)
  const [decisionNotes, setDecisionNotes] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (showAll) params.set('include_read', 'true')
    if (confirmFilter !== 'all') params.set('confirmation_status', confirmFilter)
    const res  = await fetch(`/api/alerts?${params.toString()}`)
    const data = await res.json()
    if (Array.isArray(data)) setAlerts(data)
    setLoading(false)
  }, [showAll, confirmFilter])

  useEffect(() => { load() }, [load])

  async function action(id: string, type: 'mark_read' | 'dismiss') {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: type }) })
    load()
  }

  async function decide(id: string, kind: 'confirm' | 'reject', notes?: string) {
    await fetch('/api/alerts', {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id, action: kind, notes: notes ?? null }),
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
      <div style={{ padding: '28px', maxWidth: 800 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>{t('page.title')}</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{t('page.subtitle')}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
            {confirmFlagOn && (
              <select
                value={confirmFilter}
                onChange={e => setConfirmFilter(e.target.value as ConfirmationFilter)}
                style={{ padding: '8px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#374151', cursor: 'pointer', fontFamily: 'inherit' }}
              >
                <option value="all">{t('filter.all')}</option>
                <option value="pending">{t('filter.pending')}</option>
                <option value="confirmed">{t('filter.confirmed')}</option>
                <option value="rejected">{t('filter.rejected')}</option>
                <option value="auto_resolved">{t('filter.autoResolved')}</option>
              </select>
            )}
            <button onClick={() => setShowAll(s => !s)}
              style={{ padding: '8px 14px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
              {showAll ? t('page.unreadOnly') : t('page.showAll')}
            </button>
          </div>
        </div>

        {/* Summary KPIs */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12, marginBottom: 20 }}>
          {[
            { key: 'critical', label: t('kpi.critical'), value: critical, color: critical > 0 ? '#dc2626' : '#111' },
            { key: 'high',     label: t('kpi.high'),     value: high,     color: high     > 0 ? '#ea580c' : '#111' },
            { key: 'unread',   label: t('kpi.unread'),   value: unread,   color: unread   > 0 ? '#1a1f2e' : '#111' },
            { key: 'total',    label: t('kpi.total'),    value: alerts.length, color: '#111' },
          ].map(k => (
            <div key={k.key} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 28, fontWeight: 600, color: k.color }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Alert list */}
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{t('list.loading')}</div>
        ) : alerts.length === 0 ? (
          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
            <div style={{ fontWeight: 600, color: '#15803d', fontSize: 15, marginBottom: 6 }}>{t('list.allClear')}</div>
            <div style={{ fontSize: 13, color: '#9ca3af' }}>{t('list.empty')}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {alerts.map(alert => {
              const s = SEV[alert.severity] ?? SEV.low
              const conf = alert.confirmation_status ?? 'pending'
              const decided = conf === 'confirmed' || conf === 'rejected' || conf === 'auto_resolved'
              return (
                <div key={alert.id} style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 12, padding: '16px 20px', opacity: alert.is_read ? 0.7 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' as const }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: s.text }}>
                          {alert.severity} · {(() => {
                            try { return t(`type.${alert.alert_type}`) }
                            catch { return alert.alert_type }
                          })()}
                        </span>
                        {alert.businesses && (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>
                            {alert.businesses.name}{alert.businesses.city ? ` (${alert.businesses.city})` : ''}
                          </span>
                        )}
                        {confirmFlagOn && conf !== 'pending' && <ConfirmationBadge status={conf} t={t} />}
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#111', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {alert.title}
                        <AiBadge label="AI" />
                      </div>
                      <div style={{ fontSize: 13, color: '#555', lineHeight: 1.5 }}>{alert.description}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                        {t('card.detected', { created: fmtDate(alert.created_at), period: fmtDate(alert.period_date) })}
                        {confirmFlagOn && alert.confirmation_notes && (
                          <span style={{ display: 'block', marginTop: 4, fontStyle: 'italic' as const, color: '#6b7280' }}>
                            “{alert.confirmation_notes}”
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginLeft: 16, flexShrink: 0, flexWrap: 'wrap' as const, justifyContent: 'flex-end' }}>
                      {confirmFlagOn && !decided && (
                        <>
                          <button
                            onClick={() => { setDecisionNotes(''); setDecisionModal({ id: alert.id, action: 'confirm' }) }}
                            title={t('card.confirmTooltip')}
                            style={{ padding: '5px 10px', background: 'white', border: `1px solid ${s.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', color: '#15803d', fontWeight: 600 }}>
                            {t('card.confirm')}
                          </button>
                          <button
                            onClick={() => { setDecisionNotes(''); setDecisionModal({ id: alert.id, action: 'reject' }) }}
                            title={t('card.rejectTooltip')}
                            style={{ padding: '5px 10px', background: 'white', border: `1px solid ${s.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', color: '#6b7280' }}>
                            {t('card.reject')}
                          </button>
                        </>
                      )}
                      {!alert.is_read && (
                        <button onClick={() => action(alert.id, 'mark_read')}
                          style={{ padding: '5px 10px', background: 'white', border: `1px solid ${s.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', color: s.text }}>
                          {t('card.markRead')}
                        </button>
                      )}
                      <button onClick={() => action(alert.id, 'dismiss')}
                        style={{ padding: '5px 10px', background: 'white', border: `1px solid ${s.border}`, borderRadius: 6, fontSize: 11, cursor: 'pointer', color: '#9ca3af' }}>
                        {t('card.dismiss')}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
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

// ─── Sub-components ────────────────────────────────────────────────────────

function ConfirmationBadge({ status, t }: { status: 'confirmed' | 'rejected' | 'auto_resolved' | 'pending'; t: any }) {
  const palette = status === 'confirmed'
    ? { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0', label: t('badge.confirmed') }
    : status === 'rejected'
    ? { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb', label: t('badge.rejected') }
    : status === 'auto_resolved'
    ? { bg: '#dbeafe', fg: '#1d4ed8', border: '#bfdbfe', label: t('badge.autoResolved') }
    : { bg: '#fef3c7', fg: '#92400e', border: '#fde68a', label: t('badge.pending') }
  return (
    <span style={{
      display:       'inline-flex',
      alignItems:    'center',
      gap:           4,
      fontSize:      10,
      fontWeight:    600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
      padding:       '2px 7px',
      borderRadius:  999,
      background:    palette.bg,
      color:         palette.fg,
      border:        `1px solid ${palette.border}`,
    }}>
      {palette.label}
    </span>
  )
}

function DecisionModal({ action, notes, setNotes, onCancel, onConfirm, t }: {
  action:    'confirm' | 'reject'
  notes:     string
  setNotes:  (s: string) => void
  onCancel:  () => void
  onConfirm: () => void
  t:         any
}) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position:       'fixed' as const, inset: 0, background: 'rgba(17,24,39,0.5)',
        display:        'flex', alignItems: 'center', justifyContent: 'center',
        zIndex:         100, padding: 20,
      }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: 20, width: 460, maxWidth: '100%' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#111', margin: '0 0 6px 0' }}>
          {action === 'confirm' ? t('modal.confirmTitle') : t('modal.rejectTitle')}
        </h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px 0', lineHeight: 1.5 }}>
          {action === 'confirm' ? t('modal.confirmBody') : t('modal.rejectBody')}
        </p>
        <label style={{ fontSize: 11, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
          {t('modal.notes')}
        </label>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder={t('modal.placeholder')}
          rows={3}
          maxLength={500}
          style={{
            width: '100%', padding: 10, border: '1px solid #e5e7eb', borderRadius: 7,
            fontSize: 13, fontFamily: 'inherit', color: '#111',
            resize: 'vertical' as const, boxSizing: 'border-box' as const, lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} style={{ padding: '7px 14px', background: 'transparent', border: 'none', color: '#6b7280', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
            {t('modal.cancel')}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '7px 14px',
              background: action === 'confirm' ? '#15803d' : '#1a1f2e',
              color: 'white', border: 'none', borderRadius: 7,
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
            {action === 'confirm' ? t('modal.confirmAction') : t('modal.rejectAction')}
          </button>
        </div>
      </div>
    </div>
  )
}

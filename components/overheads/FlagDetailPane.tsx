'use client'
// components/overheads/FlagDetailPane.tsx
//
// Right pane of the redesigned overheads-review page. Shows a single
// (supplier, category) group: header, action bar with cross-period scope
// language, AI explanation, 12-month price chart, period chips + invoice
// drilldown, related-periods card.
//
// The detail pane is "read-mostly": it consumes the parent's selected
// FlagGroup and fires its own data (supplier-history + drilldown) on
// mount and when the period chip changes.

import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { FlagGroup, Flag, Category } from './types'
import SupplierPriceChart, { HistoryPoint } from './SupplierPriceChart'
import PeriodChips, { PeriodKey } from './PeriodChips'

interface Props {
  group:        FlagGroup
  bizId:        string
  busy:         boolean
  onEssential:  (flagId: string) => void
  onPlanCancel: (flagId: string, reason?: string) => void
  onDefer:      (flagId: string) => void
  onReexplain:  (flagId: string) => Promise<void>
  onBack?:      () => void   // mobile only
}

interface DrilldownInvoice {
  source_type:        'supplier_invoice' | 'manual_journal'
  source_id:          string
  fortnox_url:        string
  file_id:            string | null
  date:               string
  invoice_number:     string
  supplier_name:      string
  amount:             number
  full_total:         number | null
  account:            number
  account_description: string | null
  description:        string | null
}

interface SupplierGroup {
  supplier_name:            string
  supplier_name_normalised: string
  total:                    number
  invoice_count:            number
  invoices:                 DrilldownInvoice[]
}

interface DrilldownPayload {
  flagged_total:   number
  suppliers:       SupplierGroup[]
  manual_journals: DrilldownInvoice[]
}

export default function FlagDetailPane({
  group, bizId, busy,
  onEssential, onPlanCancel, onDefer, onReexplain, onBack,
}: Props) {
  const t  = useTranslations('overheads.review.detail')
  const tCat = useTranslations('overheads.categories')
  const tT = useTranslations('overheads.review.flagTones')
  const tM = useTranslations('overheads')
  const monthsShort: string[] = (tM.raw('months.short') as string[])
    ?? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  const f = group.latest

  // Periods for the chip switcher — every flag (latest + others). Sorted
  // newest first.
  const periods = useMemo<PeriodKey[]>(() => {
    const all = [group.latest, ...group.others]
    const map = new Map<string, PeriodKey>()
    for (const x of all) {
      const k = `${x.period_year}-${x.period_month}`
      if (!map.has(k)) map.set(k, { year: x.period_year, month: x.period_month })
    }
    return Array.from(map.values()).sort((a, b) =>
      (b.year * 100 + b.month) - (a.year * 100 + a.month))
  }, [group])

  const [selectedPeriod, setSelectedPeriod] = useState<PeriodKey>({
    year: f.period_year, month: f.period_month,
  })
  // Reset when the group itself changes (user picks a different supplier).
  useEffect(() => {
    setSelectedPeriod({ year: group.latest.period_year, month: group.latest.period_month })
  }, [group.key])

  // ── 12-month supplier history ─────────────────────────────────────────
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  useEffect(() => {
    let abort = false
    setHistoryLoading(true)
    setHistoryError(null)
    setHistory([])
    fetch(
      `/api/overheads/supplier-history?business_id=${bizId}` +
      `&supplier_name_normalised=${encodeURIComponent(f.supplier_name_normalised)}` +
      `&category=${f.category}&months=12`,
      { cache: 'no-store' },
    )
      .then(r => r.json())
      .then(j => {
        if (abort) return
        if (Array.isArray(j?.history)) setHistory(j.history)
        else setHistoryError(j?.error ?? 'history_failed')
      })
      .catch(e => { if (!abort) setHistoryError(e?.message ?? 'history_failed') })
      .finally(() => { if (!abort) setHistoryLoading(false) })
    return () => { abort = true }
  }, [bizId, f.supplier_name_normalised, f.category])

  // ── Per-period drilldown ──────────────────────────────────────────────
  const [drilldown, setDrilldown] = useState<DrilldownPayload | null>(null)
  const [drilldownLoading, setDrilldownLoading] = useState(false)
  const [drilldownError, setDrilldownError] = useState<string | null>(null)
  useEffect(() => {
    let abort = false
    setDrilldownLoading(true)
    setDrilldownError(null)
    setDrilldown(null)
    fetch('/api/integrations/fortnox/drilldown', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      cache:   'no-store',
      body:    JSON.stringify({
        business_id: bizId,
        year:        selectedPeriod.year,
        month:       selectedPeriod.month,
        category:    f.category,
      }),
    })
      .then(async r => {
        const j = await r.json().catch(() => null) as any
        if (abort) return
        if (!r.ok) {
          if (j?.error === 'no_fortnox_connection') setDrilldownError(t('drilldownNoConnection'))
          else setDrilldownError(j?.error ?? 'drilldown_failed')
          return
        }
        setDrilldown(j as DrilldownPayload)
      })
      .catch(e => { if (!abort) setDrilldownError(e?.message ?? 'drilldown_failed') })
      .finally(() => { if (!abort) setDrilldownLoading(false) })
    return () => { abort = true }
  }, [bizId, selectedPeriod.year, selectedPeriod.month, f.category, t])

  // Match the Fortnox drilldown's supplier groups to OUR supplier — same
  // defensive matching as the legacy InvoiceDrilldown.
  const matchedGroup = useMemo<SupplierGroup | null>(() => {
    if (!drilldown) return null
    const target = String(f.supplier_name_normalised ?? '').toLowerCase().trim()
    const exact  = drilldown.suppliers.find(s => s.supplier_name_normalised === target)
    if (exact) return exact
    const fuzzy = drilldown.suppliers.find(s =>
      s.supplier_name.toLowerCase().includes(f.supplier_name.toLowerCase()) ||
      f.supplier_name.toLowerCase().includes(s.supplier_name.toLowerCase()))
    return fuzzy ?? null
  }, [drilldown, f])

  // Flag's badge tone + label for the header.
  let badgeTone: 'red' | 'amber' | 'info' | 'purple' | 'gray' = 'info'
  let badgeLabel = ''
  if (f.flag_type === 'price_spike') {
    badgeTone = 'red'
    const pct = f.prior_avg_sek
      ? Math.round(((f.amount_sek - f.prior_avg_sek) / f.prior_avg_sek) * 100)
      : 0
    badgeLabel = tT('priceTpl', { sign: pct >= 0 ? '+' : '', pct })
  } else if (f.flag_type === 'dismissed_reappeared') {
    badgeTone = 'amber'; badgeLabel = tT('reappeared')
  } else if (f.flag_type === 'new_supplier') {
    badgeTone = 'info';  badgeLabel = tT('new')
  } else if (f.flag_type === 'one_off_high') {
    badgeTone = 'purple'; badgeLabel = tT('oneOff')
  } else {
    badgeTone = 'gray';  badgeLabel = tT('duplicate')
  }

  const periodLabel = `${monthsShort[f.period_month - 1]} ${f.period_year}`
  const delta = f.prior_avg_sek != null ? f.amount_sek - f.prior_avg_sek : null

  const isResolved = f.resolution_status !== 'pending'

  // ── AI explanation re-explain state ───────────────────────────────────
  const [reexplaining, setReexplaining] = useState(false)
  async function handleReexplain() {
    if (reexplaining) return
    setReexplaining(true)
    try { await onReexplain(f.id) } finally { setReexplaining(false) }
  }

  // ── Plan-to-cancel modal ──────────────────────────────────────────────
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelReason,    setCancelReason]    = useState('')

  const totalAcrossPeriods = group.totalAmount

  return (
    <div style={paneStyle}>
      {onBack && (
        <button onClick={onBack} style={mobileBackStyle} type="button">
          {t('backToList')}
        </button>
      )}

      {/* HEADER */}
      <div style={headStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' as const }}>
            <BadgeLarge tone={badgeTone}>{badgeLabel}</BadgeLarge>
            <BadgeLarge tone="gray">{tCat(f.category === 'food_cost' ? 'food' : 'overhead')}</BadgeLarge>
            {isResolved && <BadgeLarge tone="gray">{t('resolvedBadge')}</BadgeLarge>}
          </div>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: UX.ink1, letterSpacing: '-0.015em', margin: '0 0 4px 0', lineHeight: 1.2, overflowWrap: 'anywhere' as const }}>
            {f.supplier_name}
          </h2>
          {f.reason && <div style={{ fontSize: 13, color: UX.ink3, overflowWrap: 'anywhere' as const }}>{f.reason}</div>}
        </div>
        <div style={{ textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
          <div style={{
            fontSize: 28, fontWeight: 700, color: badgeTone === 'red' ? UX.redInk : UX.ink1,
            letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' as const,
          }}>
            {fmtKr(f.amount_sek)}
          </div>
          <div style={{ fontSize: 12, color: UX.ink4, marginTop: 4 }}>{t('periodMonthly', { period: periodLabel })}</div>
          {delta != null && Math.abs(delta) > 1 && (
            <div style={{
              fontSize: 13, fontWeight: 600,
              color: delta > 0 ? UX.redInk : UX.greenInk,
              marginTop: 6,
            }}>
              {delta > 0 ? '↑ ' : '↓ '}{fmtKr(Math.abs(delta))} {t('vsAvg')}
            </div>
          )}
        </div>
      </div>

      {/* ACTION BAR */}
      <div style={actionBarStyle}>
        <div style={{ fontSize: 13, color: UX.ink3, lineHeight: 1.4, minWidth: 0, overflowWrap: 'anywhere' as const }}>
          <strong style={{ color: UX.ink1, fontWeight: 600 }}>
            {isResolved ? t('alreadyDecided') : t('decisionNeeded')}
          </strong>
          <span style={{ display: 'block', fontSize: 11, color: UX.ink4, marginTop: 4, fontStyle: 'italic' as const }}>
            {scopeNote(t, f.category, group.pendingCount, tCat)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' as const }}>
          <button
            type="button"
            onClick={() => onDefer(f.id)}
            disabled={busy || isResolved}
            style={btnDefer(busy || isResolved)}
          >
            {t('defer')}
          </button>
          <button
            type="button"
            onClick={() => setShowCancelModal(true)}
            disabled={busy || isResolved}
            style={btnCancel(busy || isResolved)}
          >
            {t('planCancel')}
          </button>
          <button
            type="button"
            onClick={() => onEssential(f.id)}
            disabled={busy || isResolved}
            style={btnEssential(busy || isResolved)}
          >
            {t('essential')}
          </button>
        </div>
      </div>

      {/* BODY */}
      <div style={bodyStyle}>

        {/* AI EXPLANATION */}
        <Section header={t('aiHeader')} extra={
          f.ai_explanation
            ? <button onClick={handleReexplain} disabled={reexplaining} style={reexplainLinkStyle(reexplaining)}>
                {reexplaining ? t('reexplaining') : t('reexplain')}
              </button>
            : null
        }>
          {f.ai_explanation ? (
            <div style={aiExplanationStyle}>
              <div style={{ whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const }}>{f.ai_explanation}</div>
              {f.ai_confidence != null && (
                <div style={{
                  marginTop: 10, paddingTop: 10,
                  borderTop: `1px solid ${UX.borderSoft}`,
                  fontSize: 11, color: UX.ink4,
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <span>{t('confidence', { value: fmtPct(f.ai_confidence * 100) })}</span>
                </div>
              )}
            </div>
          ) : (
            <div style={aiExplanationEmptyStyle}>
              <div>{t('aiEmpty')}</div>
              <button type="button" onClick={handleReexplain} disabled={reexplaining} style={genBtnStyle(reexplaining)}>
                {reexplaining ? t('generating') : t('generate')}
              </button>
            </div>
          )}
        </Section>

        {/* PRICE HISTORY CHART */}
        <Section header={t('chartHeader')} extra={<NewDataPill text={t('newData')} />}>
          <SupplierPriceChart
            history={history}
            loading={historyLoading}
            error={historyError ? t('chartError') : null}
          />
        </Section>

        {/* INVOICE LIST */}
        <Section
          header={t('invoicesHeader', {
            period: `${monthsShort[selectedPeriod.month - 1]} ${selectedPeriod.year}`,
          })}
          extraText={t('invoicesScope')}
        >
          <PeriodChips
            periods={periods}
            selected={selectedPeriod}
            onSelect={setSelectedPeriod}
          />
          {drilldownLoading && (
            <div style={{ fontSize: 12, color: UX.ink3, padding: '14px 0' }}>{t('drilldownLoading')}</div>
          )}
          {drilldownError && !drilldownLoading && (
            <div style={{ fontSize: 12, color: UX.redInk, padding: 10, background: UX.redSoft, border: `1px solid ${UX.redBorder}`, borderRadius: 6 }}>
              {drilldownError}
            </div>
          )}
          {!drilldownLoading && !drilldownError && matchedGroup && matchedGroup.invoices.length > 0 && (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {matchedGroup.invoices.map((inv, i) => (
                <InvoiceRow key={`${inv.source_id}-${i}`} invoice={inv} bizId={bizId} monthsShort={monthsShort} />
              ))}
            </ul>
          )}
          {!drilldownLoading && !drilldownError && (!matchedGroup || matchedGroup.invoices.length === 0) && (
            <div style={{ fontSize: 12, color: UX.ink4, padding: '14px 0' }}>
              {t('drilldownEmpty', { supplier: f.supplier_name })}
            </div>
          )}
        </Section>

        {/* RELATED PERIODS */}
        {group.pendingCount > 1 && (
          <Section header={t('relatedHeader')}>
            <div style={relatedCardStyle}>
              {t('relatedBody', {
                supplier: f.supplier_name,
                count:    group.pendingCount,
                total:    fmtKr(totalAcrossPeriods),
              })}
            </div>
          </Section>
        )}
      </div>

      {showCancelModal && (
        <CancelModal
          supplier={f.supplier_name}
          reason={cancelReason}
          setReason={setCancelReason}
          busy={busy}
          onCancel={() => { setShowCancelModal(false); setCancelReason('') }}
          onConfirm={() => {
            const r = cancelReason.trim() || undefined
            setShowCancelModal(false)
            onPlanCancel(f.id, r)
            setCancelReason('')
          }}
        />
      )}
    </div>
  )
}

function scopeNote(
  t: ReturnType<typeof useTranslations>,
  category: Category,
  pendingCount: number,
  tCat: ReturnType<typeof useTranslations>,
) {
  const catLabel = tCat(category === 'food_cost' ? 'food' : 'overhead')
  if (pendingCount <= 1) return t('scopeSingle', { category: catLabel })
  return t('scopeMulti', { category: catLabel, count: pendingCount })
}

// ────────────────────────────────────────────────────────────────────────
//   Invoice row
// ────────────────────────────────────────────────────────────────────────

function InvoiceRow({ invoice, bizId, monthsShort }: {
  invoice:     DrilldownInvoice
  bizId:       string
  monthsShort: string[]
}) {
  const t = useTranslations('overheads.review.detail')
  const d = new Date(invoice.date)
  const dateLabel = `${monthsShort[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}`
  const fileUrl = invoice.file_id
    ? `/api/integrations/fortnox/file?business_id=${bizId}&file_id=${encodeURIComponent(invoice.file_id)}&filename=${encodeURIComponent(invoice.invoice_number || invoice.source_id || 'invoice')}.pdf`
    : null

  return (
    <li style={{
      padding:      '11px 0',
      borderBottom: `1px solid ${UX.borderSoft}`,
      display:      'grid',
      gridTemplateColumns: '80px minmax(0, 1fr) auto auto',
      gap:          12,
      alignItems:   'center',
      fontSize:     13,
    }}>
      <span style={{ color: UX.ink3, fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums' as const }}>
        {dateLabel}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: UX.ink2, fontWeight: 500, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>
          #{invoice.invoice_number || invoice.source_id}
        </div>
        <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>
          {invoice.account_description ?? `Konto ${invoice.account}`}
        </div>
      </div>
      <span style={{
        fontWeight: 700, color: UX.ink1, textAlign: 'right' as const, whiteSpace: 'nowrap' as const,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>
        {fmtKr(invoice.amount)}
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        {fileUrl && (
          <a href={fileUrl} target="_blank" rel="noopener noreferrer" style={invoiceActionStyle}>
            {t('invoicePdf')}
          </a>
        )}
        {/* "Open in Fortnox" link removed — Fortnox's web UI URL pattern
            isn't reliably deep-linkable (their /supplierinvoice/{N} path
            returns 404 in the modern app). PDF view is the actually-
            useful affordance; if owner needs Fortnox, they navigate there
            themselves. */}
      </div>
    </li>
  )
}

// ────────────────────────────────────────────────────────────────────────
//   Plan-to-cancel modal
// ────────────────────────────────────────────────────────────────────────

function CancelModal({ supplier, reason, setReason, busy, onCancel, onConfirm }: {
  supplier:  string
  reason:    string
  setReason: (s: string) => void
  busy:      boolean
  onCancel:  () => void
  onConfirm: () => void
}) {
  const t = useTranslations('overheads.review.dismissModal')
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
      style={{
        position: 'fixed' as const, inset: 0, background: 'rgba(17, 24, 39, 0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20,
      }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: 20, width: 460, maxWidth: '100%' }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: UX.ink1, margin: '0 0 6px 0' }}>
          {t('title', { supplier })}
        </h2>
        <p style={{ fontSize: 12, color: UX.ink3, margin: '0 0 14px 0' }}>{t('body')}</p>
        <label style={{ fontSize: 11, fontWeight: 600, color: UX.ink2, display: 'block', marginBottom: 4 }}>
          {t('notes')}
        </label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder={t('placeholder')}
          rows={3}
          maxLength={1000}
          style={{
            width: '100%', padding: 10, border: `1px solid ${UX.borderSoft}`, borderRadius: 7,
            fontSize: 13, fontFamily: 'inherit', color: UX.ink1, resize: 'vertical' as const,
            boxSizing: 'border-box' as const, lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} disabled={busy} style={{ padding: '7px 14px', background: 'transparent', border: 'none', color: UX.ink3, fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
            {t('cancel')}
          </button>
          <button onClick={onConfirm} disabled={busy} style={{ padding: '7px 14px', background: 'white', border: `1px solid ${UX.redBorder}`, color: UX.redInk2, borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}>
            {busy ? t('saving') : t('confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
//   small bits
// ────────────────────────────────────────────────────────────────────────

function Section({ header, children, extra, extraText }: {
  header:    string
  children:  React.ReactNode
  extra?:    React.ReactNode
  extraText?:string
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 11, color: UX.ink4,
        letterSpacing: '0.08em', textTransform: 'uppercase' as const,
        fontWeight: 500, marginBottom: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>{header}</span>
        {extra}
        {extraText && <span style={{ fontSize: 11, color: UX.ink4, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>{extraText}</span>}
      </div>
      {children}
    </div>
  )
}

function NewDataPill({ text }: { text: string }) {
  return (
    <span style={{
      fontSize: 9, color: UX.indigo,
      textTransform: 'none', letterSpacing: 0, fontWeight: 700,
      background: UX.indigoBg, padding: '2px 6px',
      borderRadius: 999, border: `1px solid ${UX.borderSoft}`,
    }}>
      {text}
    </span>
  )
}

function BadgeLarge({ children, tone }: { children: React.ReactNode; tone: 'red' | 'amber' | 'info' | 'purple' | 'gray' }) {
  const palette = TONE[tone]
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '3px 10px',
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
  overflowY:     'auto',
  overflowX:     'hidden',
  display:       'flex',
  flexDirection: 'column',
  // Without minWidth:0 the pane's intrinsic content min-width (long supplier
  // names, AI explanation paragraphs, invoice description text) bubbles up
  // through the parent flex track and pushes the page wider on flag switch.
  minWidth:      0,
  width:         '100%',
  height:        '100%',
}

const mobileBackStyle: React.CSSProperties = {
  display:        'block',
  margin:         '12px 16px 0',
  padding:        '6px 12px',
  background:     'transparent',
  border:         `1px solid ${UX.border}`,
  borderRadius:   999,
  fontSize:       12,
  color:          UX.ink2,
  cursor:         'pointer',
  alignSelf:      'flex-start',
}

const headStyle: React.CSSProperties = {
  padding:             '20px 26px 16px',
  borderBottom:        `1px solid ${UX.borderSoft}`,
  display:             'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap:                 18,
  alignItems:          'flex-start',
}

const actionBarStyle: React.CSSProperties = {
  padding:             '14px 26px',
  background:          UX.subtleBg,
  borderBottom:        `1px solid ${UX.borderSoft}`,
  display:             'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap:                 18,
  alignItems:          'center',
}

const bodyStyle: React.CSSProperties = {
  padding:  '22px 26px',
  flex:     1,
  minWidth: 0,
}

function btnDefer(busy: boolean): React.CSSProperties {
  return {
    background: 'white', color: UX.ink3, border: `1px solid ${UX.border}`,
    padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 500,
    cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    opacity: busy ? 0.5 : 1,
  }
}
function btnCancel(busy: boolean): React.CSSProperties {
  return {
    background: 'white', color: UX.redInk, border: `1px solid ${UX.redBorder}`,
    padding: '8px 14px', borderRadius: 999, fontSize: 13, fontWeight: 600,
    cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    opacity: busy ? 0.5 : 1,
  }
}
function btnEssential(busy: boolean): React.CSSProperties {
  return {
    background: UX.ink1, color: 'white', border: 'none',
    padding: '8px 16px', borderRadius: 999, fontSize: 13, fontWeight: 600,
    cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    opacity: busy ? 0.5 : 1,
  }
}

const aiExplanationStyle: React.CSSProperties = {
  background: '#ebf2f8', border: '1px solid #cfdce9',
  borderLeft: '3px solid #3a6f9a',
  borderRadius: 8, padding: '14px 18px',
  fontSize: 14, lineHeight: 1.55, color: UX.ink2,
}

const aiExplanationEmptyStyle: React.CSSProperties = {
  background: UX.subtleBg, border: `1px dashed ${UX.border}`,
  borderLeft: `3px solid ${UX.border}`,
  borderRadius: 8, padding: 20,
  fontSize: 13, color: UX.ink3, textAlign: 'center' as const,
}

function genBtnStyle(busy: boolean): React.CSSProperties {
  return {
    display: 'inline-block', marginTop: 8, padding: '8px 16px',
    background: UX.ink1, color: 'white', borderRadius: 999, border: 'none',
    fontWeight: 600, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer',
    opacity: busy ? 0.6 : 1, fontFamily: 'inherit',
  }
}

function reexplainLinkStyle(busy: boolean): React.CSSProperties {
  return {
    fontSize: 11, color: UX.ink3, fontWeight: 500,
    textTransform: 'none', letterSpacing: 0, cursor: busy ? 'wait' : 'pointer',
    textDecoration: 'underline', background: 'transparent', border: 'none',
    padding: 0, fontFamily: 'inherit',
  }
}

const invoiceActionStyle: React.CSSProperties = {
  fontSize: 11, color: UX.ink3, textDecoration: 'none',
  padding: '4px 9px', border: `1px solid ${UX.borderSoft}`,
  borderRadius: 999, background: 'white', fontWeight: 500,
}

const relatedCardStyle: React.CSSProperties = {
  background: '#f3f4f0', border: `1px solid ${UX.borderSoft}`,
  borderRadius: 8, padding: '12px 16px',
  fontSize: 13, color: UX.ink2, lineHeight: 1.55,
}

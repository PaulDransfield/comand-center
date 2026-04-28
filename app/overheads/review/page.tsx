'use client'
// app/overheads/review/page.tsx
//
// Owner-facing review queue for overhead flags. Pulls /api/overheads/flags,
// renders one card per pending flag with three decision buttons. Decisions
// hit /api/overheads/flags/[id]/decide and remove the flag from the list
// optimistically. First-run backfill banner offers to mark all existing
// suppliers as essential so the queue isn't drowning the owner on day one.
//
// FIXES.md §0ap.

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Business { id: string; name: string }
interface Flag {
  id:                       string
  supplier_name:            string
  supplier_name_normalised: string
  flag_type:                'new_supplier' | 'price_spike' | 'dismissed_reappeared' | 'one_off_high' | 'duplicate_supplier'
  reason:                   string | null
  amount_sek:               number
  prior_avg_sek:            number | null
  period_year:              number
  period_month:             number
  ai_explanation:           string | null
  ai_confidence:            number | null
}

interface FlagsResponse {
  flags:                     Flag[]
  total_pending:             number
  total_monthly_savings_sek: number
  table_missing:             boolean
  note?:                     string
}

const FLAG_TONE: Record<string, { bg: string; fg: string; label: string }> = {
  new_supplier:         { bg: '#eff6ff', fg: '#1e40af', label: 'NEW' },
  price_spike:          { bg: '#fef3c7', fg: '#92400e', label: 'PRICE +%' },
  dismissed_reappeared: { bg: '#fee2e2', fg: '#991b1b', label: 'REAPPEARED' },
  one_off_high:         { bg: '#f3f4f6', fg: '#374151', label: 'ONE-OFF' },
  duplicate_supplier:   { bg: '#f5f3ff', fg: '#6b21a8', label: 'DUPLICATE?' },
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function OverheadReviewPage() {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [flags,      setFlags]      = useState<Flag[]>([])
  const [totalSavings, setTotalSavings] = useState<number>(0)
  const [loading,    setLoading]    = useState<boolean>(true)
  const [tableMissing, setTableMissing] = useState<boolean>(false)
  const [error,      setError]      = useState<string | null>(null)
  const [deciding,   setDeciding]   = useState<string | null>(null)
  // Backfill state — only show banner for businesses that have line items
  // but no classifications yet (the "first-time owner" case).
  const [showBackfillBanner, setShowBackfillBanner] = useState<boolean>(false)
  const [backfilling, setBackfilling] = useState<boolean>(false)
  const [backfillResult, setBackfillResult] = useState<{ marked: number; resolved: number } | null>(null)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const id = (saved && data.find(b => b.id === saved)) ? saved : data[0].id
      setBizId(id)
    }).catch(() => {})
    const onStorage = () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/overheads/flags?business_id=${bizId}`, { cache: 'no-store' })
      const j: FlagsResponse = await r.json()
      if (!r.ok) throw new Error((j as any)?.error ?? 'Failed to load flags')
      setFlags(j.flags ?? [])
      setTotalSavings(j.total_monthly_savings_sek ?? 0)
      setTableMissing(j.table_missing ?? false)

      // Decide backfill-banner visibility: only show when there are pending
      // flags AND the owner hasn't started classifying yet. We approximate
      // "hasn't classified" by asking the projection endpoint — if it
      // reports zero from-pending savings while flags exist, that's not it;
      // we want zero classifications. Simpler: if pending count is high
      // (>10) and no flag has been resolved yet, show the banner. Tunable.
      if (!j.table_missing) {
        const includeAll = await fetch(`/api/overheads/flags?business_id=${bizId}&include_resolved=1`, { cache: 'no-store' })
        const allJ = await includeAll.json()
        const totalEver = (allJ.flags ?? []).length
        const anyResolved = (allJ.flags ?? []).some((f: any) => f.resolution_status !== 'pending')
        setShowBackfillBanner(totalEver > 10 && !anyResolved && (j.flags?.length ?? 0) > 0)
      } else {
        setShowBackfillBanner(false)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load flags')
      setFlags([])
    } finally {
      setLoading(false)
    }
  }, [bizId])

  useEffect(() => { load() }, [load])

  async function decide(flagId: string, decision: 'essential' | 'dismissed' | 'deferred', reason?: string) {
    if (deciding) return
    setDeciding(flagId)
    setError(null)
    // Optimistic — pull the flag amount before removing for projection-update.
    const flag = flags.find(f => f.id === flagId)
    setFlags(prev => prev.filter(f => f.id !== flagId))
    if (flag && decision !== 'essential') {
      // 'essential' doesn't reduce savings; dismissed + deferred still
      // remove the row from pending so optimistically deduct from total.
      setTotalSavings(s => Math.max(0, s - Number(flag.amount_sek)))
    } else if (flag && decision === 'essential') {
      setTotalSavings(s => Math.max(0, s - Number(flag.amount_sek)))
    }

    try {
      const r = await fetch(`/api/overheads/flags/${flagId}/decide`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ decision, reason: reason ?? null }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${r.status}`)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Decision failed')
      // Re-load to restore truth.
      load()
    } finally {
      setDeciding(null)
    }
  }

  async function runBackfill() {
    if (!bizId || backfilling) return
    setBackfilling(true)
    setError(null)
    try {
      const r = await fetch('/api/overheads/backfill', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, months: 12 }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      setBackfillResult({ marked: j.suppliers_marked_essential ?? 0, resolved: j.flags_resolved ?? 0 })
      setShowBackfillBanner(false)
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Backfill failed')
    } finally {
      setBackfilling(false)
    }
  }

  const periodLabel = flags.length > 0
    ? `${MONTHS_SHORT[flags[0].period_month - 1]} ${flags[0].period_year}`
    : ''

  return (
    <AppShell>
      <PageHero
        eyebrow="OVERHEADS REVIEW"
        headline={
          flags.length > 0
            ? `${flags.length} flag${flags.length === 1 ? '' : 's'} pending · ${fmtKr(totalSavings)}/mo at stake`
            : tableMissing
              ? 'Run M039 to enable cost review'
              : 'All caught up — nothing pending review.'
        }
        context={flags.length > 0 ? periodLabel : undefined}
      />

      <div style={{ padding: '0 24px 40px', maxWidth: 960, margin: '0 auto' }}>
        {error && <Banner tone="bad" text={error} />}
        {tableMissing && (
          <Banner tone="warn" text="overhead_flags table missing — run M039-OVERHEAD-REVIEW.sql in Supabase SQL Editor." />
        )}

        {showBackfillBanner && !backfillResult && (
          <BackfillBanner
            onConfirm={runBackfill}
            onDismiss={() => setShowBackfillBanner(false)}
            busy={backfilling}
          />
        )}

        {backfillResult && (
          <Banner
            tone="ok"
            text={`Backfill complete — marked ${backfillResult.marked} supplier${backfillResult.marked === 1 ? '' : 's'} as essential, resolved ${backfillResult.resolved} pending flag${backfillResult.resolved === 1 ? '' : 's'}.`}
          />
        )}

        {loading && flags.length === 0 && (
          <Empty text="Loading flags…" />
        )}

        {!loading && !tableMissing && flags.length === 0 && (
          <Empty text="Your costs look stable. Nothing to review this period." />
        )}

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
          {flags.map(f => (
            <FlagCard
              key={f.id}
              flag={f}
              busy={deciding === f.id}
              onEssential={() => decide(f.id, 'essential')}
              onDismiss={(reason) => decide(f.id, 'dismissed', reason)}
              onDefer={() => decide(f.id, 'deferred')}
            />
          ))}
        </div>
      </div>
    </AppShell>
  )
}

// ────────────────────────────────────────────────────────────────────
//   FlagCard
// ────────────────────────────────────────────────────────────────────

function FlagCard({ flag, busy, onEssential, onDismiss, onDefer }: {
  flag:       Flag
  busy:       boolean
  onEssential: () => void
  onDismiss:   (reason?: string) => void
  onDefer:     () => void
}) {
  const [showDismissModal, setShowDismissModal] = useState<boolean>(false)
  const [dismissReason,    setDismissReason]    = useState<string>('')

  const tone = FLAG_TONE[flag.flag_type] ?? FLAG_TONE.new_supplier
  const label = tone.label === 'PRICE +%' && flag.prior_avg_sek
    ? `PRICE +${Math.round(((flag.amount_sek - flag.prior_avg_sek) / flag.prior_avg_sek) * 100)}%`
    : tone.label

  return (
    <div style={{
      background:   'white',
      border:       `1px solid ${UX.borderSoft}`,
      borderRadius: 10,
      padding:      16,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: UX.ink1 }}>{flag.supplier_name}</span>
            <span style={{
              padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              background: tone.bg, color: tone.fg,
            }}>{label}</span>
          </div>
          <div style={{ fontSize: 12, color: UX.ink3, lineHeight: 1.5 }}>
            {flag.reason ?? '—'}
            {flag.ai_explanation && (
              <span style={{ display: 'block', marginTop: 4, color: UX.ink4, fontStyle: 'italic' as const }}>
                {flag.ai_explanation}
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' as const, whiteSpace: 'nowrap' as const }}>
          <div style={{ fontSize: 18, fontWeight: 500, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
            {fmtKr(flag.amount_sek)}
          </div>
          <div style={{ fontSize: 11, color: UX.ink4 }}>this period</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button onClick={onDefer} disabled={busy} style={btnGhost(busy)}>Defer 30d</button>
        <button onClick={() => setShowDismissModal(true)} disabled={busy} style={btnDanger(busy)}>Plan to cancel</button>
        <button onClick={onEssential} disabled={busy} style={btnPrimary(busy)}>Essential</button>
      </div>

      {showDismissModal && (
        <DismissModal
          supplierName={flag.supplier_name}
          reason={dismissReason}
          setReason={setDismissReason}
          busy={busy}
          onCancel={() => { setShowDismissModal(false); setDismissReason('') }}
          onConfirm={() => {
            const r = dismissReason.trim() || null
            setShowDismissModal(false)
            onDismiss(r ?? undefined)
            setDismissReason('')
          }}
        />
      )}
    </div>
  )
}

function DismissModal({ supplierName, reason, setReason, busy, onCancel, onConfirm }: {
  supplierName: string
  reason: string
  setReason: (s: string) => void
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
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
          Plan to cancel: {supplierName}?
        </h2>
        <p style={{ fontSize: 12, color: UX.ink3, margin: '0 0 14px 0' }}>
          Marks this as a planned cancellation. Counts toward your monthly savings projection. The system will keep an eye on it — if it reappears in next month's books, you'll see a flag again.
        </p>
        <label style={{ fontSize: 11, fontWeight: 600, color: UX.ink2, display: 'block', marginBottom: 4 }}>
          Notes (optional)
        </label>
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. cancelling at end of contract, March renewal"
          rows={3}
          maxLength={1000}
          style={{
            width: '100%', padding: 10, border: `1px solid ${UX.borderSoft}`, borderRadius: 7,
            fontSize: 13, fontFamily: 'inherit', color: UX.ink1, resize: 'vertical' as const,
            boxSizing: 'border-box' as const, lineHeight: 1.5,
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={onCancel} disabled={busy} style={btnGhost(busy)}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={btnDanger(busy)}>
            {busy ? 'Saving…' : 'Plan to cancel'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   BackfillBanner — first-run UX
// ────────────────────────────────────────────────────────────────────

function BackfillBanner({ onConfirm, onDismiss, busy }: { onConfirm: () => void; onDismiss: () => void; busy: boolean }) {
  return (
    <div style={{
      background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10,
      padding: 16, marginBottom: 14,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#1e3a8a', marginBottom: 4 }}>
        First-time review — too much to wade through?
      </div>
      <div style={{ fontSize: 12, color: '#1e40af', lineHeight: 1.5, marginBottom: 12 }}>
        We can mark every supplier from the last 12 months as <strong>essential</strong> in one go. From then on, only new costs and price increases of more than 15% will be flagged.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onDismiss} disabled={busy} style={btnGhost(busy)}>No, let me review them</button>
        <button onClick={onConfirm} disabled={busy} style={btnPrimary(busy)}>
          {busy ? 'Marking…' : 'Mark all essential'}
        </button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   small UI
// ────────────────────────────────────────────────────────────────────

function Banner({ tone, text }: { tone: 'bad' | 'warn' | 'ok'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' }
    : tone === 'warn'
    ? { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' }
    : { bg: '#ecfdf5', border: '#a7f3d0', fg: '#065f46' }
  return (
    <div style={{
      background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg,
      borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12,
    }}>
      {text}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      background: 'white', border: `1px solid ${UX.borderSoft}`, borderRadius: 10,
      padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: 13,
    }}>
      {text}
    </div>
  )
}

function btnPrimary(busy: boolean): React.CSSProperties {
  return { padding: '7px 14px', background: busy ? UX.ink4 : UX.ink1, color: 'white', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer' }
}
function btnDanger(busy: boolean): React.CSSProperties {
  return { padding: '7px 14px', background: 'white', border: `1px solid ${busy ? UX.borderSoft : '#fecaca'}`, color: busy ? UX.ink4 : '#991b1b', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer' }
}
function btnGhost(busy: boolean): React.CSSProperties {
  return { padding: '7px 14px', background: 'transparent', border: 'none', color: busy ? UX.ink4 : UX.ink3, fontSize: 12, fontWeight: 500, cursor: busy ? 'not-allowed' : 'pointer' }
}

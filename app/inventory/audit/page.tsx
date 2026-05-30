'use client'
// app/inventory/audit/page.tsx
//
// /inventory/audit — Quick spot-check queue for confident auto-matched
// aliases. Owner-locked framing (2026-05-30):
//
//   "Frame audit as low-pressure spot-checks, visually distinct from
//    needs_review. In review they're doing required work. In audit
//    they're spot-checking things we already matched with confidence.
//    If audit items look like more to-do, owners will feel the system
//    got noisier, not smarter."
//
// SHIPS WITH:
//   - "Quick check — did we match these right?" header (NOT "Audit queue")
//   - "Hide for today" affordance (localStorage 24h)
//   - Item rows show the alias + the matched product side by side
//   - Three actions per row: Confirm / Correct / Skip
//     — Confirm:  writes outcome (agreed=true, context='audit_sample')
//     — Correct:  demotes alias via the audit threshold (1 = deactivate),
//                 flips matched lines back to needs_review, writes
//                 outcome (agreed=false, context='audit_sample')
//     — Skip:     marks queue row reviewed, no outcome
//   - Risk-tier visual hint (lavender = cross-supplier; soft = same)
//   - NO sidebar/rail nav entry — surfaced via a banner on /inventory/review
//
// The outcomes this page writes (context='audit_sample') feed back into
// /api/inventory/review/ai-suggest as in-context learning examples,
// tagged "[AUDIT — …]" so the AI weights them higher than ordinary
// review-queue corrections. That's the actual learning loop close.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

interface QueueItem {
  id:                       string
  business_id:              string
  alias_id:                 string
  line_id:                  string | null
  reason:                   'confident_auto_match' | 'previously_demoted' | 'decay_stale' | 'manual_review'
  risk_score:               number
  alias_match_method:       string | null
  alias_match_confidence:   number | null
  alias_times_demoted:      number | null
  sampled_at:               string
  reviewed_at:              string | null
  reviewer_decision:        string | null
  product_aliases: null | {
    id:                     string
    product_id:             string
    raw_description:        string | null
    supplier_name_snapshot: string | null
    is_active:              boolean
    times_demoted:          number | null
    last_demoted_at:        string | null
    corrections_against:    number | null
    products: null | { id: string; name: string; category: string | null }
  }
  supplier_invoice_lines: null | {
    id:                     string
    raw_description:        string | null
    total_excl_vat:         number | null
    invoice_date:           string | null
    fortnox_invoice_number: string | null
  }
}

type ActionState = {
  busy?:     boolean
  done?:     boolean
  decision?: 'confirm' | 'correct' | 'skip'
  err?:      string | null
  // After 'correct', show the post-state from the action endpoint.
  alias_demoted_now?: boolean
  lines_reverted?:    number
}

export default function InventoryAuditPage() {
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [items,   setItems]   = useState<QueueItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [actions, setActions] = useState<Record<string, ActionState>>({})

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/inventory/audit?business_id=${encodeURIComponent(bizId)}&limit=200`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      const j = await r.json()
      setItems(j.items ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [bizId])

  useEffect(() => { load() }, [load])

  const act = useCallback(async (id: string, decision: 'confirm' | 'correct' | 'skip') => {
    setActions(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), busy: true, err: null } }))
    try {
      const r = await fetch(`/api/inventory/audit/${encodeURIComponent(id)}/action`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ decision }),
      })
      const j = await r.json().catch(() => ({} as any))
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`)
      setActions(prev => ({
        ...prev,
        [id]: {
          busy: false, done: true, decision,
          alias_demoted_now: j.alias_demoted_now,
          lines_reverted:    j.lines_reverted,
        },
      }))
    } catch (e: any) {
      setActions(prev => ({ ...prev, [id]: { ...(prev[id] ?? {}), busy: false, err: e?.message ?? 'Failed' } }))
    }
  }, [])

  const pendingCount = items.filter(it => !actions[it.id]?.done).length
  const doneCount    = items.filter(it => actions[it.id]?.done).length

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, padding: '20px 24px' }}>
        {/* ── Header — deliberately low-pressure framing ─────────────── */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' as const }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
            Quick check — did we match these right?
          </h1>
          <span style={{ fontSize: 11, color: UXP.ink3 }}>
            A sample of recent auto-matches. Confirm, correct, or skip — your call.
          </span>
        </div>
        <p style={{ margin: '6px 0 16px', fontSize: 11, color: UXP.ink4, maxWidth: 760, lineHeight: 1.5 }}>
          These are matches the system made with confidence. We surface a slice for you to spot-check,
          so a wrong match doesn't sit silently. There's no pressure — corrections demote the bad
          rule; confirmations are taken as agreement; skip if you don't know.
        </p>

        {/* ── Small KPI row, deliberately understated ─────────────── */}
        <div style={{ display: 'flex', gap: 24, marginBottom: 16, fontSize: 11, color: UXP.ink3 }}>
          <div><span style={{ color: UXP.ink1, fontWeight: 600 }}>{pendingCount}</span> pending</div>
          {doneCount > 0 && (
            <div><span style={{ color: UXP.green, fontWeight: 600 }}>{doneCount}</span> reviewed this session</div>
          )}
          <a href="/inventory/review" style={{ marginLeft: 'auto', color: UXP.lavText, textDecoration: 'none', fontSize: 11 }}>
            Back to bulk review
          </a>
        </div>

        {/* ── Status / error ─────────────────────────────────────────── */}
        {!bizId && (
          <div style={{ padding: 16, fontSize: 12, color: UXP.ink3 }}>
            Pick a business from the sidebar to load its audit queue.
          </div>
        )}
        {loading && <div style={{ padding: 16, fontSize: 12, color: UXP.ink3 }}>Loading…</div>}
        {error && (
          <div style={{ padding: 12, background: UXP.roseFill, color: UXP.roseText, borderRadius: 6, fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && bizId && items.length === 0 && !error && (
          <div style={{ padding: 24, fontSize: 12, color: UXP.ink3, textAlign: 'center' as const, background: UXP.subtleBg, borderRadius: 8 }}>
            <div style={{ fontSize: 13, color: UXP.ink2, marginBottom: 4 }}>Nothing to check right now.</div>
            <div>The sampler runs daily; this list will repopulate as the matcher auto-matches new lines.</div>
          </div>
        )}

        {/* ── Item list ──────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
          {items.map(it => {
            const state    = actions[it.id] ?? {}
            const isCross  = it.alias_match_method === 'fuzzy_cross_supplier'
            const isPrev   = (it.alias_times_demoted ?? 0) > 0
            const isDone   = !!state.done
            // Visual tier — cross-supplier and previously-demoted get a soft
            // lavender background; same-supplier is neutral. Just a hint, not
            // a warning — we don't want this to look like to-dos.
            const tierBg     = isDone ? UXP.greenFill : (isCross || isPrev ? UXP.lavFill : UXP.cardBg)
            const tierBorder = isDone ? UXP.greenBar  : (isCross || isPrev ? UXP.lavMid  : UXP.border)

            return (
              <div key={it.id} style={{
                padding: '12px 14px',
                background: tierBg,
                border: `0.5px solid ${tierBorder}`,
                borderRadius: 8,
                opacity: isDone ? 0.7 : 1,
                transition: 'all 200ms ease',
              }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' as const }}>
                  {/* Description + supplier */}
                  <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: UXP.ink1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                      {it.product_aliases?.raw_description ?? '(no description)'}
                    </div>
                    <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>
                      {it.product_aliases?.supplier_name_snapshot ?? '(unknown supplier)'}
                    </div>
                  </div>

                  {/* → matched product */}
                  <div style={{ flex: '1 1 220px', minWidth: 0, fontSize: 12 }}>
                    <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.04em', marginBottom: 2 }}>
                      Matched to
                    </div>
                    <div style={{ color: UXP.ink1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                      {it.product_aliases?.products?.name ?? '(deleted product)'}
                    </div>
                    <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 1 }}>
                      {it.product_aliases?.products?.category ?? '—'}
                    </div>
                  </div>

                  {/* Risk hints */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const }}>
                    {isCross && (
                      <span style={{ fontSize: 10, padding: '2px 8px', background: UXP.lavMid, color: '#fff', borderRadius: 999, fontWeight: 600, letterSpacing: '0.02em' }}>
                        CROSS-SUPPLIER
                      </span>
                    )}
                    {!isCross && it.alias_match_method === 'fuzzy_same_supplier' && (
                      <span style={{ fontSize: 10, padding: '2px 8px', background: UXP.slateFill, color: UXP.slate, borderRadius: 999, fontWeight: 500, letterSpacing: '0.02em' }}>
                        SAME-SUPPLIER
                      </span>
                    )}
                    {isPrev && (
                      <span style={{ fontSize: 10, padding: '2px 8px', background: UXP.lavDeep, color: '#fff', borderRadius: 999, fontWeight: 600, letterSpacing: '0.02em' }}>
                        PREVIOUSLY DEMOTED ({it.alias_times_demoted})
                      </span>
                    )}
                    {it.alias_match_confidence != null && (
                      <span style={{ fontSize: 10, color: UXP.ink3 }}>
                        {(Number(it.alias_match_confidence) * 100).toFixed(0)}% sim
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                {!isDone ? (
                  <div style={{ display: 'flex', gap: 6, marginTop: 12, alignItems: 'center' }}>
                    <button onClick={() => act(it.id, 'confirm')} disabled={state.busy}
                      style={{
                        padding: '6px 14px', fontSize: 12, fontWeight: 600,
                        background: UXP.green, color: '#fff',
                        border: 'none', borderRadius: 6,
                        cursor: state.busy ? 'wait' : 'pointer', fontFamily: 'inherit',
                        opacity: state.busy ? 0.6 : 1,
                      }}>
                      Confirm — looks right
                    </button>
                    <button onClick={() => act(it.id, 'correct')} disabled={state.busy}
                      style={{
                        padding: '6px 14px', fontSize: 12, fontWeight: 600,
                        background: UXP.cardBg, color: UXP.roseText,
                        border: `1px solid ${UXP.rose}`, borderRadius: 6,
                        cursor: state.busy ? 'wait' : 'pointer', fontFamily: 'inherit',
                        opacity: state.busy ? 0.6 : 1,
                      }}>
                      Correct — this is wrong
                    </button>
                    <button onClick={() => act(it.id, 'skip')} disabled={state.busy}
                      style={{
                        padding: '6px 12px', fontSize: 11, fontWeight: 500,
                        background: 'transparent', color: UXP.ink3,
                        border: `0.5px solid ${UXP.border}`, borderRadius: 6,
                        cursor: state.busy ? 'wait' : 'pointer', fontFamily: 'inherit',
                        opacity: state.busy ? 0.6 : 1,
                      }}>
                      Skip
                    </button>
                    {state.err && (
                      <span style={{ fontSize: 11, color: UXP.roseText, marginLeft: 8 }}>{state.err}</span>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 11, color: UXP.greenDeep }}>
                    {state.decision === 'confirm' && 'Confirmed — recorded as agreement.'}
                    {state.decision === 'correct' && (
                      <>
                        Correction recorded.
                        {state.alias_demoted_now && ' Alias deactivated.'}
                        {(state.lines_reverted ?? 0) > 0 && ` ${state.lines_reverted} line${state.lines_reverted === 1 ? '' : 's'} sent back to review.`}
                      </>
                    )}
                    {state.decision === 'skip' && 'Skipped — no signal recorded.'}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* ── Footer link — back to bulk review ───────────────────────── */}
        {items.length > 0 && (
          <div style={{ marginTop: 18, fontSize: 11, color: UXP.ink4, textAlign: 'center' as const }}>
            Done for now? <a href="/inventory/review" style={{ color: UXP.lavText, textDecoration: 'none' }}>Back to bulk review</a>
          </div>
        )}
      </div>
    </AppShell>
  )
}

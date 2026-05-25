'use client'
// app/admin/v2/onboard/[businessId]/page.tsx
//
// Concierge onboarding board (Phase 1). One screen to drive a new customer
// to a full data setup without waiting on passive crons:
//   - Polls /api/admin/onboard/status every ~5s for live per-stage state.
//   - When "Auto-drive" is on, calls /api/admin/onboard/drive each cycle to
//     kick the next idle/stalled stage — closing the gaps between the
//     self-chaining workers so the slow pipelines run flat-out.
//   - Per-stage "Kick" buttons for manual re-runs.
//
// Burst is session-scoped: close the tab and normal crons finish the rest.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { adminFetch } from '@/lib/admin/v2/api-client'

interface Stage {
  key: string; label: string; state: string
  detail: string; percent: number | null; blocker: string | null; drivable: boolean
}
interface StatusResp {
  business: { id: string; name: string; org_id: string }
  stages:   Stage[]
  all_done: boolean
  at:       string
}

const POLL_MS = 5000

const STATE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  done:    { bg: '#dcfce7', fg: '#15803d', label: 'DONE' },
  running: { bg: '#ede9fe', fg: '#6d28d9', label: 'RUNNING' },
  stalled: { bg: '#fef3c7', fg: '#92400e', label: 'STALLED' },
  failed:  { bg: '#fee2e2', fg: '#991b1b', label: 'FAILED' },
  blocked: { bg: '#fee2e2', fg: '#991b1b', label: 'BLOCKED' },
  waiting: { bg: '#f1f5f9', fg: '#64748b', label: 'WAITING' },
  todo:    { bg: '#f1f5f9', fg: '#475569', label: 'TODO' },
}

export default function OnboardBoardPage() {
  const params = useParams()
  const router = useRouter()
  const businessId = String((params as any)?.businessId ?? '')

  const [data, setData]       = useState<StatusResp | null>(null)
  const [error, setError]     = useState<string | null>(null)
  const [autoDrive, setAuto]  = useState(true)
  const [lastAction, setLast] = useState<string>('')
  const [bizInput, setBizInput] = useState('')
  const [catBusy, setCatBusy] = useState(false)
  const [recBusy, setRecBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoRef = useRef(autoDrive)
  autoRef.current = autoDrive

  // One-shot catalogue auto-build (costs Haiku tokens, so it's a manual
  // button — not part of the auto-drive loop). Generates AI suggestions
  // across the needs_review queue and applies the confident, non-review ones.
  const autobuild = useCallback(async () => {
    setCatBusy(true)
    setError(null)
    try {
      // Each call classifies one ~120-group chunk + applies the confident
      // ones (kept short so it never hits the 300s function cap). Chain until
      // a round neither classifies nor applies anything new, or review is
      // empty. Cap iterations as a safety net.
      let tot = { create: 0, approve: 0, skip: 0 }
      for (let round = 1; round <= 10; round++) {
        const r = await adminFetch<any>('/api/admin/onboard/catalogue-autobuild', {
          method: 'POST', body: JSON.stringify({ business_id: businessId }),
        })
        // Nothing-to-classify case (no groups / no line descriptions): the
        // response has no count fields — show the explanation, don't NaN.
        if (r.groups === 0 || r.applied_create === undefined) {
          setLast(r.message ?? 'Nothing to classify.')
          break
        }
        tot.create += (r.applied_create ?? 0); tot.approve += (r.applied_approve ?? 0); tot.skip += (r.applied_skip ?? 0)
        setLast(`Catalogue (round ${round}): +${tot.create} new · +${tot.approve} matched · ${tot.skip} skipped · ${r.left_for_review ?? 0} need review · ${r.remaining_review_lines ?? 0} left`)
        // Only keep going if this round actually RESOLVED lines. A round that
        // classifies but applies nothing means the rest are review-tier — stop
        // (don't loop re-classifying + burning Haiku tokens).
        if ((r.applied_total ?? 0) === 0 || (r.remaining_review_lines ?? 0) === 0) break
      }
    } catch (e: any) {
      setError(e?.message ?? 'auto-build failed')
    } finally {
      setCatBusy(false)
    }
  }, [businessId])

  // One-shot AI recipe drafting (Phase 3). Drafts a recipe + ingredients
  // for each POS menu item missing one; owner reviews on /inventory/recipes.
  const draftRecipes = useCallback(async () => {
    setRecBusy(true)
    try {
      const r = await adminFetch<any>('/api/admin/onboard/recipes-draft', {
        method: 'POST', body: JSON.stringify({ business_id: businessId }),
      })
      setLast(r.message ?? `Recipes: ${r.drafted} drafted (${r.ingredients_added} ingredients) · ${r.linked_existing} linked · ${r.skipped_no_ingredients} skipped`)
    } catch (e: any) {
      setError(e?.message ?? 'recipe drafting failed')
    } finally {
      setRecBusy(false)
    }
  }, [businessId])

  const drive = useCallback(async (stage?: string) => {
    try {
      const body: any = { business_id: businessId }
      if (stage) { body.stage = stage; body.force = true }
      const r = await adminFetch<any>('/api/admin/onboard/drive', { method: 'POST', body: JSON.stringify(body) })
      if (r?.stages) setData(d => d ? { ...d, stages: r.stages } : d)
      setLast(
        r.action === 'kicked'   ? `Kicked ${r.stage} (was ${r.from_state})`
        : r.action === 'blocked' ? `Blocked: ${r.blocker}`
        : r.action === 'complete'? 'All data stages complete'
        : r.action === 'running' ? `${r.stage} running`
        : r.action === 'waiting' ? `Waiting on ${r.stage}`
        : r.action === 'error'   ? `Error kicking ${r.stage}: ${r.error}`
        : JSON.stringify(r),
      )
      return r
    } catch (e: any) {
      setError(e?.message ?? 'drive failed')
      return null
    }
  }, [businessId])

  // Combined poll + auto-drive cycle.
  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (!businessId) return
    let cancelled = false

    const tick = async () => {
      if (cancelled) return
      try {
        const s = await adminFetch<StatusResp>(`/api/admin/onboard/status?business_id=${encodeURIComponent(businessId)}`)
        if (cancelled) return
        setData(s); setError(null)
        const connect = s.stages.find(x => x.key === 'connect')
        const blocked = connect?.state === 'blocked'
        if (autoRef.current && !s.all_done && !blocked) {
          await drive()   // kicks the next idle/stalled stage
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'status failed')
      }
      if (!cancelled) timer.current = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => { cancelled = true; if (timer.current) clearTimeout(timer.current) }
  }, [businessId, drive])

  const b = data?.business

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '24px 20px', fontFamily: 'inherit', color: '#1a1f2e' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          Onboarding{b ? ` — ${b.name}` : ''}
        </h1>
        {data && (
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase',
            color: data.all_done ? '#15803d' : '#6d28d9',
          }}>
            {data.all_done ? 'Data setup complete' : 'In progress'}
          </span>
        )}
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 18 }}>
        Auto-drive keeps the slow pipelines saturated while this tab is open. You can close it any time —
        the normal crons finish the rest. Fortnox rate limits cap the raw pull speed.
      </p>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <button onClick={() => setAuto(a => !a)} style={btn(autoDrive ? '#6d28d9' : '#fff', autoDrive ? '#fff' : '#374151')}>
          {autoDrive ? 'Auto-drive: ON' : 'Auto-drive: OFF'}
        </button>
        <button onClick={() => drive()} style={btn('#fff', '#374151')}>Drive now</button>
        {lastAction && <span style={{ fontSize: 12, color: '#6b7280' }}>{lastAction}</span>}
        <span style={{ flex: 1 }} />
        <input
          placeholder="switch business_id…"
          value={bizInput}
          onChange={e => setBizInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && bizInput.trim()) router.push(`/admin/v2/onboard/${bizInput.trim()}`) }}
          style={{ fontSize: 12, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, width: 240, fontFamily: 'ui-monospace, monospace' }}
        />
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Stages */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {(data?.stages ?? []).map(s => {
          const st = STATE_STYLE[s.state] ?? STATE_STYLE.todo
          return (
            <div key={s.key} style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px', background: '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 600, fontSize: 13, minWidth: 150 }}>{s.label}</span>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', padding: '2px 7px', borderRadius: 4, background: st.bg, color: st.fg }}>
                  {st.label}
                </span>
                <span style={{ fontSize: 12, color: '#6b7280', flex: 1 }}>{s.detail}</span>
                {s.percent != null && <span style={{ fontSize: 12, fontWeight: 600, color: st.fg }}>{s.percent}%</span>}
                {s.drivable && s.state !== 'done' && (
                  <button onClick={() => drive(s.key)} style={btn('#fff', '#6d28d9', true)}>Kick</button>
                )}
                {s.key === 'catalogue' && s.state === 'todo' && (
                  <button onClick={autobuild} disabled={catBusy} style={btn('#6d28d9', '#fff', true)}>
                    {catBusy ? 'Building…' : 'Auto-build'}
                  </button>
                )}
                {s.key === 'recipes' && s.state === 'todo' && (
                  <button onClick={draftRecipes} disabled={recBusy} style={btn('#6d28d9', '#fff', true)}>
                    {recBusy ? 'Drafting…' : 'Draft recipes'}
                  </button>
                )}
              </div>
              {s.percent != null && (
                <div style={{ height: 4, background: '#f1f5f9', borderRadius: 3, marginTop: 8, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${s.percent}%`, background: st.fg, transition: 'width .6s ease' }} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function btn(bg: string, fg: string, small = false): React.CSSProperties {
  return {
    padding: small ? '3px 10px' : '6px 12px',
    fontSize: small ? 11 : 12, fontWeight: 600,
    background: bg, color: fg,
    border: `1px solid ${bg === '#fff' ? '#d1d5db' : bg}`,
    borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  }
}

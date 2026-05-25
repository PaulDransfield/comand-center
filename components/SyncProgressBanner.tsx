'use client'
// components/SyncProgressBanner.tsx
//
// Slim, non-intrusive progress strip pinned to the top of every
// authenticated page. Shows where the two background pipelines that fire
// after a Fortnox connect / re-auth are in their work:
//
//   • Financial history  — 12 months of P&L being imported
//   • Invoice scanner     — supplier invoices being pulled + matched ("scrapper")
//
// Source: /api/me/sync-progress?business_id=X (normalises both pipelines).
//
// Behaviour:
//   • Only renders while a job is in flight OR just finished (≤120s ago),
//     so the owner gets closure ("Complete") then it auto-hides.
//   • Polls every 5s while anything is active; stops polling once idle.
//   • Collapsible to a 3px progress line (state persisted) so it never
//     blocks work — the owner keeps using the app while Fortnox syncs.
//   • Scoped to the business currently selected in the sidebar.
//
// Mounted in AppShell directly under BrokenIntegrationBanner / AiUsageBanner.

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { UXP, Z } from '@/lib/constants/tokens'

type JobState = 'queued' | 'running' | 'done' | 'failed'

interface SyncJob {
  key:        'financials' | 'invoices'
  label:      string
  state:      JobState
  phaseLabel: string
  percent:    number | null
  etaSeconds: number | null
  detail:     string | null
  finishedAt: string | null
  error:      string | null
}

interface Feed {
  business_id: string
  active:      boolean
  jobs:        SyncJob[]
}

const POLL_MS         = 5000
const RECENT_DONE_MS  = 120_000   // keep showing a finished job for 2 min
const COLLAPSE_KEY    = 'cc_sync_banner_collapsed'

function fmtEta(sec: number | null): string | null {
  if (sec == null) return null
  if (sec < 45)  return '< 1 min left'
  const mins = Math.round(sec / 60)
  return `~${mins} min left`
}

// A finished/failed job is worth showing only briefly after it lands.
function isFresh(finishedAt: string | null): boolean {
  if (!finishedAt) return false
  const t = new Date(finishedAt).getTime()
  return Number.isFinite(t) && Date.now() - t < RECENT_DONE_MS
}

function shouldShow(job: SyncJob): boolean {
  if (job.state === 'queued' || job.state === 'running') return true
  return isFresh(job.finishedAt)   // done / failed → only while fresh
}

export default function SyncProgressBanner() {
  const pathname = usePathname() ?? ''
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [feed,     setFeed]     = useState<Feed | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Read collapsed preference once.
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1') } catch { /* ignore */ }
  }, [])

  // Track the sidebar's selected business (BizPicker writes cc_selected_biz).
  useEffect(() => {
    function read() {
      try { setBizId(localStorage.getItem('cc_selected_biz')) } catch { /* ignore */ }
    }
    read()
    window.addEventListener('storage', read)
    return () => window.removeEventListener('storage', read)
  }, [])

  const poll = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/me/sync-progress?business_id=${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (!r.ok) { setFeed(null); return false }
      const j: Feed = await r.json()
      setFeed(j)
      // Keep polling while anything is active OR recently finished (so the
      // "Complete" state stays visible for its 2-min window, then we stop).
      return j.active || j.jobs.some(x => (x.state === 'done' || x.state === 'failed') && isFresh(x.finishedAt))
    } catch {
      setFeed(null)
      return false
    }
  }, [])

  // Polling loop, keyed on the selected business + route. AppShell remounts
  // on route change, so navigating naturally re-checks for fresh activity.
  useEffect(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    // Don't compete with the dedicated progress UI on the integrations /
    // verify / onboarding screens, or run on auth pages.
    if (!bizId) return
    if (/^\/(login|signup|reset-password|onboarding|integrations)\b/.test(pathname)) return

    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      const keepGoing = await poll(bizId)
      if (cancelled) return
      if (keepGoing) timer.current = setTimeout(tick, POLL_MS)
    }
    tick()

    return () => {
      cancelled = true
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
    }
  }, [bizId, pathname, poll])

  function toggleCollapsed() {
    setCollapsed(c => {
      const next = !c
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  const visibleJobs = (feed?.jobs ?? []).filter(shouldShow)
  if (visibleJobs.length === 0) return null

  const anyRunning = visibleJobs.some(j => j.state === 'running' || j.state === 'queued')
  const anyFailed  = visibleJobs.some(j => j.state === 'failed')
  const allDone    = !anyRunning && !anyFailed

  // Overall percent for the collapsed sliver = mean of jobs with a percent.
  const pcts = visibleJobs.map(j => j.percent).filter((p): p is number => p != null)
  const overallPct = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null

  const accent = anyFailed ? UXP.rose : allDone ? UXP.greenDeep : UXP.lavDeep
  const fill   = anyFailed ? UXP.roseFill : allDone ? UXP.greenFill : UXP.lavFill

  // ── Collapsed: a 3px gradient line + tiny re-open handle ──────────────
  if (collapsed) {
    return (
      <div style={{ position: 'sticky', top: 0, zIndex: Z.banner }}>
        <div style={{ height: 3, background: UXP.borderSoft, position: 'relative' }}>
          <div style={{
            height: '100%',
            width: overallPct != null ? `${overallPct}%` : '100%',
            background: accent,
            transition: 'width .6s ease',
          }} />
        </div>
        <button
          onClick={toggleCollapsed}
          aria-label="Show sync progress"
          style={{
            position: 'absolute', right: 12, top: 3,
            padding: '1px 8px', fontSize: 9, fontWeight: 700,
            letterSpacing: '.08em', textTransform: 'uppercase',
            color: accent, background: fill,
            border: 'none', borderRadius: '0 0 6px 6px',
            cursor: 'pointer', fontFamily: 'inherit',
          }}>
          {allDone ? 'Synced' : 'Syncing…'}
        </button>
      </div>
    )
  }

  // ── Expanded: one compact row per job ─────────────────────────────────
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'sticky', top: 0, zIndex: Z.banner,
        background: fill,
        borderBottom: `0.5px solid ${UXP.border}`,
        padding: '7px 16px',
        display: 'flex', alignItems: 'center', gap: 16,
        fontSize: 12, color: UXP.ink1,
      }}>
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '.09em',
        textTransform: 'uppercase', color: accent, whiteSpace: 'nowrap',
      }}>
        {anyFailed ? 'Sync issue' : allDone ? 'Sync complete' : 'Fortnox syncing'}
      </span>

      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '6px 22px', minWidth: 0 }}>
        {visibleJobs.map(job => (
          <JobRow key={job.key} job={job} />
        ))}
      </div>

      {anyRunning && (
        <span style={{ fontSize: 11, color: UXP.ink3, whiteSpace: 'nowrap' }}>
          Keep working — this runs in the background.
        </span>
      )}

      <button
        onClick={toggleCollapsed}
        aria-label="Minimise sync progress"
        title="Minimise"
        style={{
          padding: '2px 8px', fontSize: 11, fontWeight: 600,
          color: accent, background: 'transparent',
          border: `0.5px solid ${UXP.border}`, borderRadius: 5,
          cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
        }}>
        Hide
      </button>
    </div>
  )
}

function JobRow({ job }: { job: SyncJob }) {
  const isDone   = job.state === 'done'
  const isFailed = job.state === 'failed'
  const accent   = isFailed ? UXP.rose : isDone ? UXP.greenDeep : UXP.lavDeep
  const eta      = fmtEta(job.etaSeconds)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{job.label}</span>

      {/* Mini progress bar — only when we have a percent */}
      {job.percent != null && (
        <span style={{
          display: 'inline-block', width: 84, height: 5,
          background: UXP.borderSoft, borderRadius: 3, overflow: 'hidden',
          flexShrink: 0,
        }}>
          <span style={{
            display: 'block', height: '100%',
            width: `${job.percent}%`, background: accent,
            transition: 'width .6s ease',
          }} />
        </span>
      )}

      <span style={{ color: accent, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {job.phaseLabel}{job.percent != null && !isDone && !isFailed ? ` ${job.percent}%` : ''}
      </span>

      {job.detail && (
        <span style={{ color: UXP.ink3, whiteSpace: 'nowrap' }}>· {job.detail}</span>
      )}

      {eta && !isDone && !isFailed && (
        <span style={{ color: UXP.ink3, whiteSpace: 'nowrap' }}>· {eta}</span>
      )}

      {isFailed && job.error && (
        <span style={{ color: UXP.roseText, whiteSpace: 'nowrap', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          · {job.error}
        </span>
      )}
    </div>
  )
}

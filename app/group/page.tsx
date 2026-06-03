'use client'
// @ts-nocheck
// app/group/page.tsx — full rebuild on the new system
//
// Multi-location roll-up. Down from 563 lines to ~430. Every surface
// on UXP + KpiCardUX / BreakdownTable; the legacy PageHero /
// SupportingStats / StatusPill / Sparkline / TopBar are gone.
//
// Data:
//   GET /api/group/overview?from&to
//     → { businesses, summary, narrative, items }
//
// Period nav lives in the AppShell toolbar's date stepper. Clicking a
// row in the BreakdownTable switches the BizPicker to that location
// and navigates to /dashboard (same UX as the old card grid).

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import KpiCardUX from '@/components/ux/KpiCard'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import { labourTier, DEFAULT_TIER_CONFIG } from '@/lib/utils/labourTier'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from:  localDate(d),
    to:    localDate(last),
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  }
}

export default function GroupPage() {
  const router = useRouter()
  const [monthOffset, setMonthOffset] = useState(0)
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')

  const period = getMonthBounds(monthOffset)

  useEffect(() => {
    setLoading(true); setError('')
    fetch(`/api/group/overview?from=${period.from}&to=${period.to}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setData(j) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset])

  function openBusiness(id: string) {
    localStorage.setItem('cc_selected_biz', id)
    window.dispatchEvent(new Event('storage'))
    router.push('/dashboard')
  }

  const businesses = data?.businesses ?? []
  const summary    = data?.summary ?? null
  const aiItems    = Array.isArray(data?.items) ? data.items : null

  // Active locations = anything with revenue OR labour activity in the
  // period. Keeps "ghost" businesses with no data off the rollup.
  const active = useMemo(
    () => businesses.filter((b: any) => Number(b.revenue ?? 0) > 0 || Number(b.staff_cost ?? 0) > 0),
    [businesses],
  )
  const ranked = useMemo(
    () => [...active].filter((b: any) => Number(b.revenue ?? 0) > 0 && b.margin_pct != null)
                     .sort((a: any, b: any) => Number(b.margin_pct) - Number(a.margin_pct)),
    [active],
  )
  const best  = ranked[0] ?? null
  const worst = ranked.length > 1 ? ranked[ranked.length - 1] : null
  const draining = active.find((b: any) => Number(b.revenue ?? 0) === 0 && Number(b.staff_cost ?? 0) > 0)

  // Period nav
  const canStepNext = monthOffset < 0
  function step(dir: -1 | 1) { setMonthOffset(o => o + dir) }

  return (
    <AppShell
      dateLabel={period.label}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {error && <Banner tone="bad" text={error} />}

        {loading && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading group rollup…</div>
        )}

        {!loading && !error && businesses.length === 0 && (
          <EmptyCard
            title="No businesses in this org yet"
            body="Add a second location to see a cross-location rollup."
          />
        )}

        {!loading && !error && businesses.length === 1 && (
          <EmptyCard
            title="Group view needs more than one location"
            body={<>This view compares locations against each other.{' '}
              <a href="/dashboard" style={{ color: UXP.lavText, textDecoration: 'underline' }}>Open the dashboard</a> for the single-location overview.</>}
          />
        )}

        {!loading && !error && businesses.length > 1 && (
          <>
            {/* KPI strip */}
            <KpiStrip summary={summary} active={active} draining={draining} best={best} worst={worst} period={period} />

            {/* Best / worst location strip */}
            {(best || worst) && <BestWorstStrip best={best} worst={worst} draining={draining} />}

            {/* Per-location breakdown */}
            {active.length > 0 && (
              <LocationBreakdown
                rows={active}
                summary={summary}
                best={best}
                worst={worst}
                onOpen={openBusiness}
              />
            )}

            {/* AI manager bullets */}
            {(aiItems?.length || best || draining) && (
              <ManagerCard items={aiItems ?? buildFallbackItems(active, summary, best, draining)} period={period.label} />
            )}
          </>
        )}
      </PageContainer>

      <AskAI
        page="group"
        orgScope
        context={summary && businesses.length > 1 ? [
          `Period: ${period.label} (${period.from} to ${period.to})`,
          `${summary.business_count} locations · revenue ${fmtKr(summary.total_revenue)} · labour ${fmtKr(summary.total_staff_cost)} (${fmtPct(summary.group_labour_pct)}) · margin ${fmtPct(summary.group_margin_pct)}`,
          businesses.map((b: any) => `${b.name}: ${fmtKr(b.revenue)} rev · ${fmtPct(b.labour_pct)} labour · ${fmtPct(b.margin_pct)} margin · ${b.hours}h`).join('\n'),
          `[NOTE TO CLAUDE: this view is ORG-WIDE, not single-business.]`,
        ].join('\n') : 'No group data yet'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function KpiStrip({ summary, active, draining, best, worst, period }: any) {
  if (!summary) {
    return null
  }
  const groupLab = Number(summary.group_labour_pct ?? 0)
  const groupMargin = Number(summary.group_margin_pct ?? 0)
  const tier = labourTier(groupLab > 0 ? groupLab : null)

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Total revenue"
        value={fmtKr(summary.total_revenue ?? 0)}
        microLabel={period.label}
      />
      <KpiCardUX
        title="Group margin"
        value={fmtPct(groupMargin)}
        variant="stacked"
        stackedBars={best && worst ? [
          { label: `${best.name}`,  value: Math.max(0, Number(best.margin_pct  ?? 0)), max: 100, color: UXP.green },
          { label: `${worst.name}`, value: Math.max(0, Number(worst.margin_pct ?? 0)), max: 100, color: UXP.rose  },
        ] : undefined}
        microLabel={`After labour · ${active.length} location${active.length === 1 ? '' : 's'}`}
      />
      <KpiCardUX
        title="Group labour"
        value={fmtPct(groupLab)}
        deltaGood={false}
        variant="targetBand"
        targetBand={groupLab > 0 ? {
          actualPct:    Math.min(100, groupLab),
          targetMinPct: DEFAULT_TIER_CONFIG.targetMin,
          targetMaxPct: DEFAULT_TIER_CONFIG.targetMax,
        } : undefined}
        microLabel={tier === 'no-data' ? 'No data' : tier.replace('-', ' ')}
      />
      <KpiCardUX
        title="Locations"
        value={String(summary.business_count ?? active.length)}
        deltaGood={false}
        delta={draining ? `1 draining` : null}
        microLabel={draining ? `${draining.name} — labour, no revenue` : `${active.length} with activity`}
      />
    </div>
  )
}

// ── Best / worst strip ──────────────────────────────────────────────
function BestWorstStrip({ best, worst, draining }: any) {
  const cards: any[] = []
  if (best) cards.push({ kind: 'best', biz: best })
  if (draining) cards.push({ kind: 'draining', biz: draining })
  else if (worst && worst !== best) cards.push({ kind: 'worst', biz: worst })
  if (cards.length === 0) return null
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))`,
      gap:                 12,
    }}>
      {cards.map(({ kind, biz }) => {
        const palette = kind === 'best'
          ? { bg: UXP.greenFill, fg: UXP.greenDeep, accent: UXP.green, label: 'Top performer' }
          : kind === 'draining'
            ? { bg: UXP.roseFill,  fg: UXP.roseText,  accent: UXP.rose,  label: 'Draining hours' }
            : { bg: UXP.roseFill,  fg: UXP.roseText,  accent: UXP.rose,  label: 'Weakest margin' }
        const valueLabel = kind === 'draining'
          ? `${Math.round(Number(biz.hours ?? 0))}h · ${fmtKr(Number(biz.staff_cost ?? 0))}`
          : fmtPct(biz.margin_pct ?? 0)
        const subLabel = kind === 'draining'
          ? 'No revenue logged'
          : `${fmtKr(biz.revenue ?? 0)} · ${biz.rev_per_hour ? `${fmtKr(biz.rev_per_hour)}/h` : '—/h'}`
        return (
          <div key={kind} style={{
            background:   UXP.cardBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_lg,
            padding:      '14px 16px',
            display:      'flex',
            gap:          12,
            alignItems:   'center',
          }}>
            <span style={{
              padding:       '4px 10px',
              background:    palette.bg,
              color:         palette.fg,
              borderRadius:  999,
              fontSize:      9,
              fontWeight:    600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
            }}>
              {palette.label}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500 }}>{biz.name}</div>
              <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1 }}>{subLabel}</div>
            </div>
            <span style={{
              fontFamily:         'var(--font-display)',
              fontSize:           22,
              fontWeight:         500,
              color:              palette.accent,
              letterSpacing:      '-0.02em',
              fontVariantNumeric: 'tabular-nums' as const,
            }}>
              {valueLabel}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Per-location BreakdownTable ─────────────────────────────────────
function LocationBreakdown({ rows, summary, best, worst, onOpen }: any) {
  const sorted = [...rows].sort((a: any, b: any) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0))
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Locations</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {sorted.length} {sorted.length === 1 ? 'location' : 'locations'} · click to open
        </div>
      </div>
      <BreakdownTable
        columns={[
          { key: 'name', header: 'Location', align: 'left', render: (r: any) => (
            <button type="button" onClick={() => onOpen(r.id)} style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: 'inherit', textAlign: 'left' as const, minWidth: 0,
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.colour ?? UXP.ink4, display: 'inline-block' }} />
                <span style={{ color: UXP.ink1, fontWeight: 500 }}>{r.name}</span>
                {best && r.id === best.id  && <Status tone="good">Best</Status>}
                {worst && r.id === worst.id && best && r.id !== best.id && <Status tone="bad">Weakest</Status>}
              </span>
              {r.city && <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, marginLeft: 14 }}>{r.city}</span>}
            </button>
          ) },
          { key: 'revenue', header: 'Revenue', align: 'right', render: (r: any) =>
            r.revenue > 0 ? fmtKr(r.revenue) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'deltaPrev', header: 'Δ prev', align: 'right', render: (r: any) => {
            if (r.revenue_delta_pct == null) {
              if (r.revenue > 0 && (r.prev_revenue ?? 0) === 0) return <DeltaChip value="new" positiveIsGood />
              return <span style={{ color: UXP.ink4 }}>—</span>
            }
            return <DeltaChip value={`${r.revenue_delta_pct >= 0 ? '+' : ''}${r.revenue_delta_pct}%`} positiveIsGood />
          } },
          { key: 'labour', header: 'Labour %', align: 'right', render: (r: any) => {
            if (r.labour_pct == null) return <span style={{ color: UXP.ink4 }}>—</span>
            const tier = labourTier(r.labour_pct)
            const palette =
              tier === 'on-target' ? { bg: UXP.greenFill, fg: UXP.greenDeep }
              : tier === 'low'     ? { bg: UXP.lavFill,   fg: UXP.lavText   }
              : tier === 'watch'   ? { bg: UXP.lavFill,   fg: UXP.coral     }
              :                      { bg: UXP.roseFill,  fg: UXP.roseText  }
            return (
              <span style={{
                display:      'inline-block',
                fontSize:     9,
                fontWeight:   500,
                padding:      '2px 7px',
                borderRadius: 6,
                background:   palette.bg,
                color:        palette.fg,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>
                {fmtPct(r.labour_pct)}
              </span>
            )
          } },
          { key: 'margin', header: 'Margin', align: 'right', render: (r: any) =>
            r.margin_pct != null ? fmtPct(r.margin_pct) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'rph', header: 'Rev/hour', align: 'right', render: (r: any) =>
            r.rev_per_hour ? fmtKr(r.rev_per_hour) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'hours', header: 'Hours', align: 'right', render: (r: any) =>
            r.hours > 0 ? `${Math.round(r.hours).toLocaleString('sv-SE')}h` : <span style={{ color: UXP.ink4 }}>—</span>
          },
        ]}
        sections={[{ rows: sorted }]}
        footer={{
          label: 'Group',
          cells: {
            revenue:    fmtKr(summary?.total_revenue ?? 0),
            deltaPrev:  '',
            labour:     fmtPct(summary?.group_labour_pct ?? 0),
            margin:     fmtPct(summary?.group_margin_pct ?? 0),
            rph:        '',
            hours:      '',
          },
        }}
        rowKey={(row: any) => row.id}
      />
    </div>
  )
}

function Status({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'lav' | 'neutral' }) {
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
    lav:     { bg: UXP.lavFill,   fg: UXP.lavText   },
    neutral: { bg: UXP.subtleBg,  fg: UXP.ink4      },
  }[tone]
  return (
    <span style={{
      display:        'inline-block',
      fontSize:       8,
      padding:        '1px 6px',
      borderRadius:   6,
      background:     palette.bg,
      color:          palette.fg,
      fontWeight:     500,
      letterSpacing:  '0.04em',
      textTransform:  'uppercase' as const,
    }}>{children}</span>
  )
}

// ── AI manager card ──────────────────────────────────────────────────
function ManagerCard({ items, period }: { items: any[]; period: string }) {
  if (!items || items.length === 0) return null
  return (
    <Card title="AI group manager" subtitle={period}>
      <div style={{ display: 'grid', gap: 0 }}>
        {items.map((it, idx) => {
          const tone: 'good' | 'warning' | 'bad' =
            it.tone === 'good' ? 'good' :
            it.tone === 'bad'  ? 'bad'  : 'warning'
          const palette = {
            good:    { bar: UXP.green, fg: UXP.greenDeep },
            warning: { bar: UXP.coral, fg: UXP.coral     },
            bad:     { bar: UXP.rose,  fg: UXP.roseText  },
          }[tone]
          return (
            <div key={idx} style={{
              display:             'grid',
              gridTemplateColumns: '4px auto 1fr',
              gap:                 12,
              alignItems:          'center',
              padding:             '10px 0',
              borderBottom:        idx < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
            }}>
              <span style={{ width: 4, height: '100%', minHeight: 24, background: palette.bar, borderRadius: 2 }} />
              <span style={{
                fontSize:      9,
                fontWeight:    600,
                letterSpacing: '0.04em',
                color:         palette.fg,
                textTransform: 'uppercase' as const,
                minWidth:      72,
              }}>{it.entity}</span>
              <span style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.4 }}>{it.message}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// Deterministic English bullets when Claude is unavailable or returns
// nothing parseable. Mirrors the rules from the legacy buildGroupAttention
// — biggest problem, opportunity, what's working.
function buildFallbackItems(active: any[], summary: any, best: any, draining: any) {
  const items: any[] = []
  if (draining) {
    items.push({
      tone: 'bad',
      entity: draining.name,
      message: `Running ${Math.round(Number(draining.hours ?? 0))}h with no revenue logged — ${fmtKr(Number(draining.staff_cost ?? 0))} of labour drain.`,
    })
  }
  if (best && best.margin_pct != null && best.margin_pct >= 30) {
    items.push({
      tone: 'good',
      entity: best.name,
      message: `Carrying the group at ${fmtPct(best.margin_pct)} margin${best.rev_per_hour ? ` · ${fmtKr(best.rev_per_hour)}/h` : ''}.`,
    })
  }
  if (summary && active.length >= 2) {
    items.push({
      tone: 'warning',
      entity: 'Group avg',
      message: `${fmtKr(summary.total_revenue)} across ${active.length} locations · ${fmtPct(summary.group_margin_pct ?? 0)} margin.`,
    })
  }
  return items.slice(0, 3)
}

// ── Generic atoms ───────────────────────────────────────────────────
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

function EmptyCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       40,
      textAlign:     'center' as const,
    }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: UXP.ink3, maxWidth: 440, margin: '0 auto', lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}

function Banner({ tone, text }: { tone: 'bad'; text: string }) {
  return (
    <div style={{
      background:    UXP.roseFill,
      border:        `0.5px solid ${UXP.rose}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         UXP.roseText,
    }}>
      {text}
    </div>
  )
}

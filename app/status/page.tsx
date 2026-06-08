// app/status/page.tsx
//
// A3.7 — public CommandCenter system status. Server-rendered for fast
// first paint; no auth required. Pulls /api/status which aggregates
// per-pillar cron health into a green / yellow / red signal.
//
// Used by:
//   - prospects checking "is the system real / does it stay up"
//   - existing customers when something feels off
//   - the team's external monitoring (curls /api/status JSON)

import Link from 'next/link'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type Tier = 'green' | 'yellow' | 'red' | 'unknown'

interface Pillar {
  key:      string
  label:    string
  status:   Tier
  last_run: string | null
  message:  string
}

interface StatusPayload {
  overall:     Tier
  pillars:     Pillar[]
  computed_at: string
}

async function fetchStatus(): Promise<StatusPayload | null> {
  try {
    const base = process.env.NEXT_PUBLIC_APP_URL || 'https://comandcenter.se'
    const r = await fetch(`${base}/api/status`, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

export default async function StatusPage() {
  const data = await fetchStatus()

  return (
    <main style={S.page}>
      <header style={S.header}>
        <Link href="/" style={S.brand}>CommandCenter</Link>
        <div style={S.subtitle}>System status</div>
      </header>

      {!data ? (
        <div style={S.banner}>Status feed currently unavailable.</div>
      ) : (
        <>
          <OverallBadge tier={data.overall} />
          <div style={S.pillars}>
            {data.pillars.map(p => <PillarRow key={p.key} p={p} />)}
          </div>
          <div style={S.footer}>
            Updated {formatRelative(data.computed_at)} · auto-refreshes when this page reloads.
          </div>
        </>
      )}

      <div style={S.legend}>
        <Dot tier="green" /> Operational — last run within 24 hours
        &nbsp;·&nbsp;
        <Dot tier="yellow" /> Behind schedule — within 48 hours
        &nbsp;·&nbsp;
        <Dot tier="red" /> Outage — older than 48 hours or actively failing
      </div>
    </main>
  )
}

function OverallBadge({ tier }: { tier: Tier }) {
  const message = tier === 'green'   ? 'All systems operational'
                : tier === 'yellow'  ? 'Degraded performance'
                : tier === 'red'     ? 'Service disruption'
                :                      'Status unknown'
  return (
    <div style={{ ...S.overall, background: tierBg(tier), color: tierFg(tier) }}>
      <Dot tier={tier} large />
      {message}
    </div>
  )
}

function PillarRow({ p }: { p: Pillar }) {
  return (
    <div style={S.pillar}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Dot tier={p.status} />
        <div>
          <div style={S.pillarLabel}>{p.label}</div>
          <div style={S.pillarMessage}>
            {p.message}{p.last_run ? ` · ${formatRelative(p.last_run)}` : ''}
          </div>
        </div>
      </div>
    </div>
  )
}

function Dot({ tier, large = false }: { tier: Tier; large?: boolean }) {
  const size = large ? 12 : 10
  return (
    <span style={{
      display:     'inline-block',
      width:       size,
      height:      size,
      borderRadius: '50%',
      background:  tierDot(tier),
    }} />
  )
}

function tierBg(tier: Tier): string {
  return tier === 'green'  ? '#e6f7ee'
       : tier === 'yellow' ? '#fff4e0'
       : tier === 'red'    ? '#fdebee'
       :                     '#f5f5f5'
}
function tierFg(tier: Tier): string {
  return tier === 'green'  ? '#1f7a4d'
       : tier === 'yellow' ? '#a17418'
       : tier === 'red'    ? '#a3243a'
       :                     '#666'
}
function tierDot(tier: Tier): string {
  return tier === 'green'  ? '#2c9b65'
       : tier === 'yellow' ? '#cf8b1a'
       : tier === 'red'    ? '#c43554'
       :                     '#bbb'
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return iso
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}

const S: Record<string, React.CSSProperties> = {
  page:          { maxWidth: 720, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif', color: '#3a3550' },
  header:        { marginBottom: 24 },
  brand:         { fontSize: 14, color: '#5b4a86', textDecoration: 'none', letterSpacing: '-0.01em' },
  subtitle:      { fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 6 },
  banner:        { padding: '14px 18px', background: '#faf9fd', borderRadius: 10, color: '#7a7390', fontSize: 13 },
  overall:       { padding: '16px 20px', borderRadius: 12, display: 'inline-flex', alignItems: 'center', gap: 12, fontWeight: 500, fontSize: 16, marginBottom: 24 },
  pillars:       { display: 'grid', gap: 8, marginBottom: 18 },
  pillar:        { padding: '14px 16px', background: '#fff', borderRadius: 10, border: '0.5px solid rgba(58,53,80,0.08)' },
  pillarLabel:   { fontSize: 14, fontWeight: 500 },
  pillarMessage: { fontSize: 11, color: '#7a7390', marginTop: 2 },
  footer:        { fontSize: 11, color: '#7a7390', marginBottom: 28 },
  legend:        { fontSize: 10, color: '#7a7390', borderTop: '0.5px solid rgba(58,53,80,0.08)', paddingTop: 14, lineHeight: 1.6 },
}

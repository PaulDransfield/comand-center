'use client'
// app/revisor/[bizId]/[year]/[month]/page.tsx
//
// Month detail page for the revisor surface. Shows everything the
// accountant needs for a monthly close:
//   - Business header (name, org-nr, period)
//   - P&L summary card (revenue, food, staff, other, depreciation,
//     financial, net_profit, margin)
//   - BAS line items grouped by class (3xxx/4xxx/5xxx/6xxx/7xxx/8xxx)
//   - History: 12-month trend for revenue + margin
//   - Overhead flags with drilldown to source invoice PDFs
//   - Print-friendly stylesheet (Ctrl/Cmd+P → clean PDF)
//
// Read-only. No mutations on this surface.

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { UX, UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
// Phase 5 — Bookkeeping. Accountant close-the-month KpiCardUX strip:
// Intäkter (3xxx) · Kostnader (4-7xxx) · Resultat · Marginal. Avstämd
// chip beside the title when the period sourced from a Fortnox PDF
// (the human-reviewed path) — see CLAUDE.md Session 17 invariants.
import KpiCardUX from '@/components/ux/KpiCard'

const MONTH_NAMES_SV = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

interface Business {
  id:         string
  name:       string                  // owner-set display / trading name (e.g. "Chicce Slotsgatan")
  city:       string | null
  country:    string | null
  org_number: string | null
  legal_name: string | null           // legal entity per Fortnox (e.g. "Aglianico i Örebro AB")
  legal_city: string | null
}

interface Tracker {
  revenue:         number | null
  food_cost:       number | null
  staff_cost:      number | null
  other_cost:      number | null
  depreciation:    number | null
  financial:       number | null
  net_profit:      number | null
  margin_pct:      number | null
  dine_in_revenue:  number | null
  takeaway_revenue: number | null
  alcohol_revenue:  number | null
  source:           string | null
  created_via:      string | null
  updated_at:       string | null
}

interface LineItem {
  account_number:      string | null
  account_description: string | null
  amount:              number | null
  kind:                string | null
  source:              string | null
}

interface HistoryRow {
  period_year:  number
  period_month: number
  revenue:      number | null
  food_cost:    number | null
  staff_cost:   number | null
  other_cost:   number | null
  net_profit:   number | null
  margin_pct:   number | null
}

interface OverheadFlag {
  id?:           string
  category?:     string
  rule_id?:      string
  reason?:       string
  amount_kr?:    number
  baseline_kr?:  number
  severity?:     string
}

interface MonthData {
  mode:            'month_detail'
  business:        Business
  period:          { year: number; month: number }
  tracker:         Tracker | null
  line_items:      LineItem[]
  history:         HistoryRow[]
  overhead_flags:  OverheadFlag[]
  generated_at:    string
}

export default function RevisorMonthDetail() {
  const params = useParams() as { bizId: string; year: string; month: string }
  const [data, setData]       = useState<MonthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    const qs = new URLSearchParams({
      business_id: params.bizId,
      year:        params.year,
      month:       params.month,
    })
    fetch(`/api/revisor/data?${qs.toString()}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { setData(j); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [params.bizId, params.year, params.month])

  if (loading) return <Layout><Empty text="Laddar…" /></Layout>
  if (error)   return <Layout><Banner tone="bad" text={error} /></Layout>
  if (!data)   return <Layout><Empty text="Ingen data" /></Layout>

  const m = data.period.month
  const y = data.period.year
  const periodLabel = `${MONTH_NAMES_SV[m - 1]} ${y}`
  const t = data.tracker

  // Phase R1 (REVISOR-COMPLIANCE-PLAN.md) — Bokföringslagen 7 kap. archival
  // compliance: every printed page carries identifying business + period
  // + source + timestamp. Format the period as a strict ISO date range so
  // it's audit-trail unambiguous.
  const periodStart = `${y}-${String(m).padStart(2, '0')}-01`
  const periodEnd   = (() => {
    // Last day of the month — use the JS Date trick (day 0 of next month).
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
  })()
  const generatedAt = new Date().toLocaleString('sv-SE', {
    year:   'numeric', month: '2-digit', day:    '2-digit',
    hour:   '2-digit', minute: '2-digit',
    hour12: false,
  })
  const sourceLabel = (() => {
    const src = t?.source ?? null
    if (src === 'fortnox_pdf')   return 'Fortnox (manuellt avstämd PDF)'
    if (src === 'fortnox_apply') return 'Fortnox (apply-pipeline)'
    if (src === 'fortnox_api')   return 'Fortnox API'
    if (src === 'manual')        return 'Manuellt inmatat'
    return src ?? 'okänd'
  })()

  // BFL 7 kap. requires the LEGAL entity name on archival print-outs.
  // Fall back to the display name only when Fortnox hasn't given us
  // a legal_name yet (pre-identity-sync businesses).
  const legalEntityName = data.business.legal_name?.trim() || data.business.name
  const displayCity     = data.business.legal_city?.trim() || data.business.city || null

  return (
    <Layout>
      <PrintStyles
        businessName={legalEntityName}
        orgNumber={data.business.org_number}
        periodStart={periodStart}
        periodEnd={periodEnd}
        periodLabel={periodLabel}
        generatedAt={generatedAt}
      />

      <div className="cc-revisor-content">
        {/* ── Header ───────────────────────────────────────────────── */}
        <div style={{
          marginBottom:   24,
          paddingBottom:  18,
          borderBottom:   `1px solid ${UXP.border}`,
        }}>
          <a
            href="/revisor"
            style={{
              fontSize: 12, color: UXP.ink3, textDecoration: 'none',
              display: 'inline-block', marginBottom: 8,
            }}
            className="cc-no-print"
          >
            ← Alla månader
          </a>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: UXP.ink1, margin: 0, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
            <span>Månadsavslut · {periodLabel}</span>
            {t && (t.source === 'fortnox_pdf' || t.source === 'fortnox_apply') && (
              <span style={{
                fontSize:      10,
                fontWeight:    600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase' as const,
                padding:       '3px 8px',
                background:    UXP.greenFill,
                color:         UXP.greenDeep,
                borderRadius:  999,
              }}>
                Avstämd
              </span>
            )}
          </h1>
          <div style={{ fontSize: 13, color: UXP.ink3, marginTop: 4 }}>
            <strong>{legalEntityName}</strong>
            {data.business.legal_name && data.business.legal_name !== data.business.name && (
              <> <span style={{ color: UXP.ink4 }}>(handelsnamn: {data.business.name})</span></>
            )}
            {data.business.org_number && <> · Org.nr {formatOrgNr(data.business.org_number)}</>}
            {displayCity && <> · {displayCity}</>}
          </div>

          {/* Phase R2 — SIE 4 download. Hidden in print (cc-no-print).
              On click: navigates to the API route which streams the
              SIE file as application/x-sie. The browser handles the
              download attribute + Content-Disposition combination
              transparently. */}
          <div className="cc-no-print" style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <a
              href={`/api/revisor/sie?business_id=${encodeURIComponent(data.business.id)}&year=${y}&month=${m}`}
              download
              style={{
                display:        'inline-flex',
                alignItems:     'center',
                gap:            6,
                padding:        '7px 14px',
                background:     UXP.lavDeep,
                color:          'white',
                border:         'none',
                borderRadius:   8,
                fontSize:       12,
                fontWeight:     600,
                textDecoration: 'none',
              }}
              title="Ladda ner verifikationsfil i SIE 4-format (ISO-8859-1, för import till Visma, Capego, Wolters Kluwer m.fl.)"
            >
              ⇩ Ladda ner SIE-fil
            </a>
            <span style={{ fontSize: 10, color: UXP.ink4 }}>
              Importeras i revisorns verktyg (Visma, Capego, Wolters Kluwer, Fortnox, m.fl.)
            </span>
          </div>
        </div>

        {/* Phase 5 KPI strip — accountant close-the-month roll-up. Reads
            the same tracker_data row that powers the resultaträkning
            grid below; presentation only. */}
        {t && (() => {
          const intakter = Number(t.revenue ?? 0)
          const kostnader = Number(t.food_cost ?? 0) + Number(t.staff_cost ?? 0) + Number(t.other_cost ?? 0)
          const resultat = Number(t.net_profit ?? 0)
          const marginal = t.margin_pct != null ? Number(t.margin_pct) : null
          return (
            <div
              style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap:                 12,
                marginBottom:        18,
              }}
            >
              <KpiCardUX
                title="Intäkter (3xxx)"
                value={fmtKr(intakter)}
                microLabel={periodLabel}
              />
              <KpiCardUX
                title="Kostnader (4-7xxx)"
                value={fmtKr(kostnader)}
                deltaGood={false}
                microLabel={intakter > 0 ? `${((kostnader / intakter) * 100).toFixed(1)}% av oms` : ''}
              />
              <KpiCardUX
                title="Resultat"
                value={fmtKr(resultat)}
                deltaGood
                delta={resultat >= 0 ? '+' : '−'}
              />
              <KpiCardUX
                title="Marginal"
                value={marginal != null ? marginal.toFixed(1) + '%' : '—'}
                variant="targetBand"
                targetBand={marginal != null ? {
                  actualPct:    Math.max(0, Math.min(100, marginal)),
                  targetMinPct: 5,
                  targetMaxPct: 15,
                } : undefined}
                microLabel="Mål 5-15%"
              />
            </div>
          )
        })()}

        {/* ── P&L summary card ────────────────────────────────────── */}
        {t == null ? (
          <Banner tone="warn" text="Ingen avslutad P&L för denna period. Antingen är månaden inte stängd än, eller så har Fortnox-data inte synkroniserats." />
        ) : (
          <Section title="Resultaträkning (sammandrag)">
            <div style={{
              display:    'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap:        14,
              padding:    '10px 4px',
            }}>
              <Metric label="Omsättning"      value={fmtKr(t.revenue)} tone="neutral" />
              <Metric label="Råvarukostnad"   value={fmtKr(t.food_cost)}  tone="neutral" sub={pctOf(t.food_cost,  t.revenue)} />
              <Metric label="Personalkostnad" value={fmtKr(t.staff_cost)} tone="neutral" sub={pctOf(t.staff_cost, t.revenue)} />
              <Metric label="Övriga kostnader" value={fmtKr(t.other_cost)} tone="neutral" sub={pctOf(t.other_cost, t.revenue)} />
              <Metric label="Avskrivningar"    value={fmtKr(t.depreciation)} tone="neutral" />
              <Metric label="Finansiella"      value={fmtKr(t.financial)} tone="neutral" />
              <Metric
                label="Resultat"
                value={fmtKr(t.net_profit)}
                tone={(t.net_profit ?? 0) >= 0 ? 'good' : 'bad'}
                sub={pctOf(t.net_profit, t.revenue)}
              />
              <Metric
                label="Marginal"
                value={t.margin_pct != null ? Number(t.margin_pct).toFixed(1) + '%' : '—'}
                tone={(t.margin_pct ?? 0) >= 10 ? 'good' : (t.margin_pct ?? 0) >= 5 ? 'warn' : 'bad'}
              />
            </div>

            {/* VAT-coded revenue split */}
            {(t.dine_in_revenue || t.takeaway_revenue || t.alcohol_revenue) ? (
              <div style={{
                marginTop:    4,
                padding:      '10px 12px',
                background:   UXP.pageBg,
                borderRadius: 6,
                fontSize:     12,
                color:        UXP.ink3,
              }}>
                <strong style={{ color: UXP.ink2 }}>Intäktsfördelning enligt momssats:</strong>{' '}
                Servering 12% {fmtKr(t.dine_in_revenue)} ·
                Take-away 6% {fmtKr(t.takeaway_revenue)} ·
                Alkohol 25% {fmtKr(t.alcohol_revenue)}
              </div>
            ) : null}

            <div style={{ marginTop: 6, fontSize: 11, color: UXP.ink4 }}>
              Källa: <strong>{t.source ?? '—'}</strong>
              {t.created_via && <> · Inläst via {t.created_via}</>}
              {t.updated_at  && <> · Uppdaterad {fmtDateTime(t.updated_at)}</>}
            </div>
          </Section>
        )}

        {/* ── BAS line items ───────────────────────────────────────── */}
        {data.line_items.length > 0 && (
          <Section title="BAS-klassificerade poster">
            <BasTable items={data.line_items} />
          </Section>
        )}

        {/* ── Overhead flags ───────────────────────────────────────── */}
        {data.overhead_flags.length > 0 && (
          <Section title="Kostnadsflaggor för granskning">
            <FlagsTable flags={data.overhead_flags} bizId={data.business.id} year={y} month={m} />
          </Section>
        )}

        {/* ── Balansräkning (Phase R4) — ABL 6 kap. balance sheet ─── */}
        <Section title="Balansräkning">
          <BalanceSheetCard bizId={data.business.id} year={y} month={m} />
        </Section>

        {/* ── Momsrapport (Phase R5) — Skatteverket SKV 4700 ──────── */}
        <Section title="Momsrapport (SKV 4700)">
          <MomsrapportCard bizId={data.business.id} year={y} month={m} />
        </Section>

        {/* ── Verifikationslista (Phase R3) — BFL 5 kap. journal ──── */}
        <Section title="Verifikationslista">
          <VerifikationsList bizId={data.business.id} year={y} month={m} />
        </Section>

        {/* ── 12-month trend ───────────────────────────────────────── */}
        {data.history.length > 1 && (
          <Section title="12-månaders trend">
            <TrendTable history={data.history} currentPeriod={data.period} />
          </Section>
        )}

        {/* ── BFL 7 kap. compliance footer ─────────────────────────── */}
        <ComplianceFooter
          businessName={legalEntityName}
          tradingName={data.business.legal_name ? data.business.name : null}
          orgNumber={data.business.org_number}
          periodStart={periodStart}
          periodEnd={periodEnd}
          generatedAt={generatedAt}
          sourceLabel={sourceLabel}
        />
      </div>
    </Layout>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────

function BasTable({ items }: { items: LineItem[] }) {
  // Group by BAS class (first digit of account)
  const groups = items.reduce<Record<string, LineItem[]>>((g, item) => {
    const cls = (item.account_number ?? '?')[0] ?? '?'
    if (!g[cls]) g[cls] = []
    g[cls].push(item)
    return g
  }, {})
  const classOrder = ['3', '4', '5', '6', '7', '8', '?']
  const classLabel: Record<string, string> = {
    '3': 'Intäkter (3xxx)',
    '4': 'Råvaror (4xxx)',
    '5': 'Lokal/övriga (5xxx)',
    '6': 'Övriga kostnader (6xxx)',
    '7': 'Personal (7xxx)',
    '8': 'Finansiella (8xxx)',
    '?': 'Okänd kontoklass',
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
      <thead>
        <tr style={{ color: UXP.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UXP.border}` }}>
          <th style={th()}>Konto</th>
          <th style={th()}>Beskrivning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Belopp</th>
        </tr>
      </thead>
      <tbody>
        {classOrder.flatMap(cls => {
          const g = groups[cls]
          if (!g || g.length === 0) return []
          const subtotal = g.reduce((s, i) => s + Number(i.amount ?? 0), 0)
          return [
            <tr key={`hdr-${cls}`} style={{ background: UXP.pageBg }}>
              <td colSpan={2} style={{ ...td(), fontWeight: 600, color: UXP.ink2 }}>{classLabel[cls]}</td>
              <td style={{ ...td(), textAlign: 'right' as const, fontWeight: 600, color: UXP.ink2 }}>
                {fmtKr(subtotal)}
              </td>
            </tr>,
            ...g.map((i, idx) => (
              <tr key={`${cls}-${idx}`} style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
                <td style={td()}><code style={{ fontSize: 11, color: UXP.ink3 }}>{i.account_number}</code></td>
                <td style={td()}>{i.account_description}</td>
                <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(i.amount)}</td>
              </tr>
            )),
          ]
        })}
      </tbody>
    </table>
  )
}

function FlagsTable({ flags, bizId, year, month }: { flags: OverheadFlag[]; bizId: string; year: number; month: number }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
      <thead>
        <tr style={{ color: UXP.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UXP.border}` }}>
          <th style={th()}>Kategori</th>
          <th style={th()}>Anledning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Belopp</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Baslinje</th>
          <th style={th()}>Drill-down</th>
        </tr>
      </thead>
      <tbody>
        {flags.map((f, idx) => (
          <tr key={f.id ?? idx} style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
            <td style={td()}>{f.category ?? '—'}</td>
            <td style={td()}>{f.reason ?? '—'}</td>
            <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(f.amount_kr)}</td>
            <td style={{ ...td(), textAlign: 'right' as const, color: UXP.ink3 }}>{fmtKr(f.baseline_kr)}</td>
            <td style={td()}>
              {f.category && (
                <a
                  href={`/api/integrations/fortnox/drilldown?business_id=${bizId}&year=${year}&month=${month}&category=${encodeURIComponent(f.category)}`}
                  style={{ fontSize: 11, color: UXP.ink3 }}
                  className="cc-no-print"
                  target="_blank"
                  rel="noopener"
                >
                  Visa fakturor →
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ═════════════════════════════════════════════════════════════════
// Phase R4 — Balansräkning (ABL 6 kap. balance sheet)
// ═════════════════════════════════════════════════════════════════

interface BalanceSheetLineDto {
  account:     number
  description: string
  amount:      number
}
interface BalanceSheetGroupDto {
  title:  string
  lines:  BalanceSheetLineDto[]
  total:  number
}
interface BalanceSheetSectionDto {
  title:  string
  groups: BalanceSheetGroupDto[]
  total:  number
}
interface BalanceSheetDto {
  period_end_date:              string
  fiscal_year_from:             string
  fiscal_year_to:               string
  assets:                       BalanceSheetSectionDto
  equity:                       BalanceSheetSectionDto
  liabilities:                  BalanceSheetSectionDto
  total_assets:                 number
  total_equity_and_liabilities: number
  imbalance:                    number
  ytd_result:                   number
  voucher_count:                number
}

function BalanceSheetCard({ bizId, year, month }: { bizId: string; year: number; month: number }) {
  const [bs,      setBs]      = useState<BalanceSheetDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setBs(null)
    fetch(`/api/revisor/balance-sheet?business_id=${bizId}&year=${year}&month=${month}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { if (!cancelled) setBs(j) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bizId, year, month])

  if (loading) return (
    <div style={{ padding: 20, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
      <div style={{ marginBottom: 6 }}>Beräknar balansräkning…</div>
      <div style={{ fontSize: 10, color: UXP.ink4, maxWidth: 480, margin: '0 auto', lineHeight: 1.5 }}>
        Första gången per räkenskapsår hämtar vi verifikationer och ingående balanser från Fortnox — kan ta upp till en minut för aktiva räkenskapsår. Resultatet cachelagras så efterföljande månader laddas direkt.
      </div>
    </div>
  )
  if (error)   return <Banner tone="bad" text={`Kunde inte beräkna balansräkningen: ${error}`} />
  if (!bs)     return <Empty text="Ingen balansdata för perioden." />

  // Tolerance matches the readiness validator: floor 5 kr OR 0.001 % of
  // total assets, whichever is larger. Integer-rounding of opening
  // balances (we round to whole kr in account-balance.ts) generates
  // typical noise of ±1-3 kr — flagging that as "Obalans" alarms the
  // owner over what's literally rounding. A real bookkeeping imbalance
  // crosses this threshold easily.
  const okTolerance = Math.max(5, Math.abs(bs.total_assets) * 1e-5)
  const imbalanceAbs = Math.abs(bs.imbalance)
  const balanced = imbalanceAbs <= okTolerance

  return (
    <div>
      <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 10 }}>
        Per {bs.period_end_date} · Räkenskapsår {bs.fiscal_year_from} – {bs.fiscal_year_to} · Underlag från {bs.voucher_count.toLocaleString('sv-SE')} verifikationer
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* LEFT: Assets */}
        <BalanceSheetColumn section={bs.assets} grandLabel="Summa tillgångar" grandValue={bs.total_assets} />
        {/* RIGHT: Equity + Liabilities */}
        <div>
          <BalanceSheetColumn section={bs.equity}      grandLabel={null} grandValue={null} />
          <div style={{ marginTop: 14 }}>
            <BalanceSheetColumn section={bs.liabilities} grandLabel="Summa eget kapital och skulder" grandValue={bs.total_equity_and_liabilities} />
          </div>
        </div>
      </div>

      {/* Balance check banner */}
      <div style={{
        marginTop:   14,
        padding:     '10px 14px',
        background:  balanced ? UXP.greenFill : UXP.roseFill,
        border:      `0.5px solid ${balanced ? UXP.green : UXP.rose}`,
        borderRadius: 8,
        fontSize:    12,
        color:       balanced ? UXP.greenDeep : UXP.roseText,
      }}>
        {balanced ? (
          <>
            <strong>✓ Balanserar.</strong> Tillgångar {fmtKr(bs.total_assets)} = Eget kapital + skulder {fmtKr(bs.total_equity_and_liabilities)}
            {imbalanceAbs >= 0.5 ? <> (±{fmtKr(imbalanceAbs)} avrundning)</> : null}.
            {Math.abs(bs.ytd_result) > 0.5 && <> Inkluderar årets resultat YTD <strong>{fmtKr(bs.ytd_result)}</strong>.</>}
          </>
        ) : (
          <>
            <strong>⚠ Obalans: {fmtKr(bs.imbalance)}.</strong>{' '}
            Tillgångar {fmtKr(bs.total_assets)} ≠ Eget kapital + skulder {fmtKr(bs.total_equity_and_liabilities)}.
            Kan bero på att ingående balans saknas i Fortnox eller att vissa konton inte hämtades. Kontrollera mot Fortnox direkt.
          </>
        )}
      </div>
    </div>
  )
}

function BalanceSheetColumn({
  section, grandLabel, grandValue,
}: {
  section:    BalanceSheetSectionDto
  grandLabel: string | null
  grandValue: number | null
}) {
  return (
    <div>
      <div style={{
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        color:         UXP.ink4,
        paddingBottom: 4,
        borderBottom:  `1px solid ${UXP.border}`,
        marginBottom:  6,
      }}>
        {section.title}
      </div>
      {section.groups.length === 0 ? (
        <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>Inga poster.</div>
      ) : (
        section.groups.map((g, gi) => (
          <div key={gi} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 4, marginTop: gi > 0 ? 8 : 0 }}>
              {g.title}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }}>
              <tbody>
                {g.lines.map((l, li) => (
                  <tr key={li}>
                    <td style={{ padding: '2px 4px', fontFamily: 'ui-monospace, monospace' as const, color: UXP.ink3, width: 50 }}>{l.account}</td>
                    <td style={{ padding: '2px 6px', color: UXP.ink2 }}>{l.description}</td>
                    <td style={{ padding: '2px 4px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1 }}>{fmtKr(l.amount)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                  <td style={{ padding: '4px' }}></td>
                  <td style={{ padding: '4px 6px', fontSize: 10, color: UXP.ink3, fontStyle: 'italic' as const }}>Delsumma</td>
                  <td style={{ padding: '4px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 500, color: UXP.ink2 }}>{fmtKr(g.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))
      )}
      {grandLabel !== null && grandValue !== null && (
        <div style={{
          marginTop:    8,
          paddingTop:   6,
          borderTop:    `1px solid ${UXP.ink2}`,
          display:      'flex',
          justifyContent: 'space-between',
          fontSize:     12,
          fontWeight:   600,
          color:        UXP.ink1,
        }}>
          <span>{grandLabel}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(grandValue)}</span>
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════
// Phase R5 — Momsrapport (Skatteverket SKV 4700 VAT report)
// ═════════════════════════════════════════════════════════════════

interface MomsrapportLineDto {
  account:     number
  description: string
  amount:      number
}
interface MomsrapportBoxDto {
  box:         number
  label:       string
  amount:      number
  lines:       MomsrapportLineDto[]
}
interface MomsrapportDto {
  period_label:        string
  period_from:         string
  period_to:           string
  box_05:              MomsrapportBoxDto
  box_06:              MomsrapportBoxDto
  box_07:              MomsrapportBoxDto
  box_08:              MomsrapportBoxDto
  box_10:              MomsrapportBoxDto
  box_11:              MomsrapportBoxDto
  box_12:              MomsrapportBoxDto
  box_30:              MomsrapportBoxDto
  box_31:              MomsrapportBoxDto
  box_32:              MomsrapportBoxDto
  box_48:              MomsrapportBoxDto
  box_35:              MomsrapportBoxDto
  box_36:              MomsrapportBoxDto
  box_38:              MomsrapportBoxDto
  box_39:              MomsrapportBoxDto
  box_40:              MomsrapportBoxDto
  total_output_vat:    number
  total_input_vat:     number
  box_49:              number
  implied_sales_25:    number
  implied_sales_12:    number
  implied_sales_06:    number
  implied_sales_total: number
  reconciliation: {
    declared_sales: number
    implied_sales:  number
    diff_kr:        number
    diff_pct:       number
    in_tolerance:   boolean
  }
  voucher_count:       number
}

function MomsrapportCard({ bizId, year, month }: { bizId: string; year: number; month: number }) {
  const [m,       setM]       = useState<MomsrapportDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setM(null)
    fetch(`/api/revisor/momsrapport?business_id=${bizId}&year=${year}&month=${month}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { if (!cancelled) setM(j) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bizId, year, month])

  if (loading) return <Empty text="Beräknar momsrapport…" />
  if (error)   return <Banner tone="bad" text={`Kunde inte beräkna momsrapporten: ${error}`} />
  if (!m)      return <Empty text="Ingen momsdata för perioden." />

  const isRefund = m.box_49 < 0

  return (
    <div>
      <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 10 }}>
        Period {m.period_from} – {m.period_to} · {m.period_label} · Underlag från {m.voucher_count.toLocaleString('sv-SE')} verifikationer
      </div>

      {/* Two-column main layout: A (sales excl. VAT + EU/utland) left,  B+D+E+G (VAT figures) right */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* LEFT: A. Försäljning + F. EU / utland */}
        <div>
          <MomsSection title="A. Momspliktig försäljning (exkl. moms)">
            <MomsBoxRow b={m.box_05} />
            {m.box_06.amount !== 0 && <MomsBoxRow b={m.box_06} />}
            {m.box_07.amount !== 0 && <MomsBoxRow b={m.box_07} />}
            {m.box_08.amount !== 0 && <MomsBoxRow b={m.box_08} />}
          </MomsSection>

          {(m.box_35.amount + m.box_36.amount + m.box_38.amount + m.box_39.amount + m.box_40.amount !== 0) && (
            <div style={{ marginTop: 14 }}>
              <MomsSection title="F. Försäljning till utlandet">
                {m.box_35.amount !== 0 && <MomsBoxRow b={m.box_35} />}
                {m.box_36.amount !== 0 && <MomsBoxRow b={m.box_36} />}
                {m.box_38.amount !== 0 && <MomsBoxRow b={m.box_38} />}
                {m.box_39.amount !== 0 && <MomsBoxRow b={m.box_39} />}
                {m.box_40.amount !== 0 && <MomsBoxRow b={m.box_40} />}
              </MomsSection>
            </div>
          )}
        </div>

        {/* RIGHT: B + D + E (VAT figures) */}
        <div>
          <MomsSection title="B. Utgående moms på försäljning">
            <MomsBoxRow b={m.box_10} />
            <MomsBoxRow b={m.box_11} />
            <MomsBoxRow b={m.box_12} />
          </MomsSection>

          {(m.box_30.amount + m.box_31.amount + m.box_32.amount !== 0) && (
            <div style={{ marginTop: 14 }}>
              <MomsSection title="D. Utgående moms omvänd skattskyldighet">
                {m.box_30.amount !== 0 && <MomsBoxRow b={m.box_30} />}
                {m.box_31.amount !== 0 && <MomsBoxRow b={m.box_31} />}
                {m.box_32.amount !== 0 && <MomsBoxRow b={m.box_32} />}
              </MomsSection>
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <MomsSection title="E. Ingående moms">
              <MomsBoxRow b={m.box_48} />
            </MomsSection>
          </div>
        </div>
      </div>

      {/* G. Net VAT — full-width banner */}
      <div style={{
        marginTop:    14,
        padding:      '12px 14px',
        background:   isRefund ? UXP.greenFill : UXP.lavFill,
        border:       `0.5px solid ${isRefund ? UXP.green : UXP.lavMid}`,
        borderRadius: 8,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <div>
            <div style={{ fontSize: 10, color: UXP.ink3, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
              G. Ruta 49 — Moms att {isRefund ? 'få tillbaka' : 'betala'}
            </div>
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4 }}>
              Utgående moms {fmtKr(m.total_output_vat)} − ingående moms {fmtKr(m.total_input_vat)}
            </div>
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
            {fmtKr(Math.abs(m.box_49))}
          </div>
        </div>
      </div>

      {/* Reconciliation diagnostic */}
      <div style={{
        marginTop:    10,
        padding:      '8px 12px',
        background:   m.reconciliation.in_tolerance ? UXP.greenFill : UXP.roseFill,
        border:       `0.5px solid ${m.reconciliation.in_tolerance ? UXP.green : UXP.rose}`,
        borderRadius: 6,
        fontSize:     11,
        color:        m.reconciliation.in_tolerance ? UXP.greenDeep : UXP.roseText,
      }}>
        {m.reconciliation.in_tolerance ? (
          <>
            <strong>✓ Avstämning OK.</strong>{' '}
            Försäljning i ruta 05 ({fmtKr(m.reconciliation.declared_sales)}) stämmer med implicit försäljning från utgående moms ({fmtKr(m.reconciliation.implied_sales)}).
            Avvikelse {m.reconciliation.diff_pct.toFixed(2)} %.
          </>
        ) : (
          <>
            <strong>⚠ Avstämningsavvikelse.</strong>{' '}
            Ruta 05 ({fmtKr(m.reconciliation.declared_sales)}) skiljer sig från implicit försäljning ({fmtKr(m.reconciliation.implied_sales)}) med {fmtKr(Math.abs(m.reconciliation.diff_kr))} ({m.reconciliation.diff_pct.toFixed(1)} %).
            Implicerat: 25 % {fmtKr(m.implied_sales_25)} · 12 % {fmtKr(m.implied_sales_12)} · 6 % {fmtKr(m.implied_sales_06)}.
            Kan bero på momsfri försäljning bokförd i taxable konton eller saknade utgående moms-rader.
          </>
        )}
      </div>
    </div>
  )
}

function MomsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        color:         UXP.ink4,
        paddingBottom: 4,
        borderBottom:  `1px solid ${UXP.border}`,
        marginBottom:  6,
      }}>
        {title}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }}>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function MomsBoxRow({ b }: { b: MomsrapportBoxDto }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <tr style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
        <td style={{ padding: '4px 4px', width: 40, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 600 }}>
          {b.box}
        </td>
        <td style={{ padding: '4px 6px', color: UXP.ink2 }}>{b.label}</td>
        <td style={{ padding: '4px 4px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1, width: 100, fontWeight: 500 }}>
          {fmtKr(b.amount)}
        </td>
        <td style={{ padding: '4px 4px', width: 36 }} className="cc-no-print">
          {b.lines.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              style={{ fontSize: 10, padding: '2px 6px', background: 'transparent', border: `0.5px solid ${UXP.borderSoft}`, borderRadius: 4, cursor: 'pointer', color: UXP.ink3 }}
              title={open ? 'Dölj konton' : 'Visa konton'}
            >
              {open ? '−' : '+'}
            </button>
          )}
        </td>
      </tr>
      {(open || b.lines.length > 0) && open && b.lines.map((l, i) => (
        <tr key={i} style={{ background: UXP.subtleBg }}>
          <td style={{ padding: '2px 4px', width: 40 }}></td>
          <td style={{ padding: '2px 6px', fontSize: 10, color: UXP.ink3 }}>
            <code style={{ fontFamily: 'ui-monospace, monospace' as const, color: UXP.ink3 }}>{l.account}</code> {l.description}
          </td>
          <td style={{ padding: '2px 4px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink3, fontSize: 10 }}>
            {fmtKr(l.amount)}
          </td>
          <td style={{ padding: '2px 4px' }}></td>
        </tr>
      ))}
    </>
  )
}

// ═════════════════════════════════════════════════════════════════
// Phase R3 — Verifikationslista (BFL 5 kap. journal-by-date)
// ═════════════════════════════════════════════════════════════════

interface VoucherRowDto {
  account:             number
  account_description: string
  debit:               number
  credit:              number
  description:         string | null
}
interface VoucherDto {
  series:        string
  number:        number
  date:          string
  description:   string | null
  rows:          VoucherRowDto[]
  debit_total:   number
  credit_total:  number
}

function VerifikationsList({ bizId, year, month }: { bizId: string; year: number; month: number }) {
  const [vouchers,  setVouchers]  = useState<VoucherDto[] | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [showAll,   setShowAll]   = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setVouchers(null)
    fetch(`/api/revisor/vouchers?business_id=${bizId}&year=${year}&month=${month}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { if (!cancelled) setVouchers(j.vouchers ?? []) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bizId, year, month])

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
        Hämtar verifikationer från Fortnox… (kan ta upp till en minut för en aktiv månad)
      </div>
    )
  }
  if (error) {
    return (
      <div style={{ padding: 12, background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`, borderRadius: 8, fontSize: 12, color: UXP.roseText }}>
        Kunde inte hämta verifikationer: {error}
      </div>
    )
  }
  if (!vouchers || vouchers.length === 0) {
    return <Empty text="Inga verifikationer för perioden." />
  }

  // On-screen we collapse to the first 50 by default to keep the page
  // responsive; print always shows all. The cc-print-only class is
  // injected in PrintStyles so the print version uses the full list.
  const visibleOnScreen = showAll ? vouchers : vouchers.slice(0, 50)
  const hiddenCount     = vouchers.length - visibleOnScreen.length

  // Period grand totals (for the BFL 5 kap. footer row)
  const grandDebit  = vouchers.reduce((s, v) => s + v.debit_total,  0)
  const grandCredit = vouchers.reduce((s, v) => s + v.credit_total, 0)
  const transTotal  = vouchers.reduce((s, v) => s + v.rows.length, 0)

  return (
    <div>
      <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 8 }}>
        {vouchers.length.toLocaleString('sv-SE')} verifikationer ·{' '}
        {transTotal.toLocaleString('sv-SE')} transaktioner ·{' '}
        Debet {fmtKr(grandDebit)} = Kredit {fmtKr(grandCredit)}
        {Math.abs(grandDebit - grandCredit) > 0.5 && (
          <span style={{ color: UXP.roseText, marginLeft: 6 }}>
            (obalans {fmtKr(Math.abs(grandDebit - grandCredit))})
          </span>
        )}
      </div>

      {/* Toggle is screen-only — print always renders all */}
      {hiddenCount > 0 && (
        <div className="cc-no-print" style={{ marginBottom: 8 }}>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            style={{
              fontSize: 11, padding: '5px 11px',
              background: UXP.lavFill, color: UXP.lavText,
              border: `0.5px solid ${UXP.lavMid}`, borderRadius: 6,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Visa alla {vouchers.length} verifikationer (just nu visas {visibleOnScreen.length})
          </button>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }}>
        <thead>
          <tr style={{ background: UXP.subtleBg }}>
            <th style={{ ...th(), width: 90  }}>Datum</th>
            <th style={{ ...th(), width: 70  }}>Ver.</th>
            <th style={{ ...th(), width: 70  }}>Konto</th>
            <th style={{ ...th(), textAlign: 'left' as const }}>Beskrivning</th>
            <th style={{ ...th(), width: 110, textAlign: 'right' as const }}>Debet</th>
            <th style={{ ...th(), width: 110, textAlign: 'right' as const }}>Kredit</th>
          </tr>
        </thead>
        <tbody>
          {/* On screen — the visible slice. Print — see <PrintAllVouchers> below */}
          {visibleOnScreen.map(v => (
            <VoucherBlock key={`${v.series}-${v.number}`} voucher={v} />
          ))}
        </tbody>
        {/* Period grand totals footer */}
        <tfoot>
          <tr style={{ background: UXP.subtleBg, fontWeight: 600 }}>
            <td style={td()} colSpan={4}>
              Period totalt ({vouchers.length} verifikationer · {transTotal} transaktioner)
            </td>
            <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(grandDebit)}</td>
            <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(grandCredit)}</td>
          </tr>
        </tfoot>
      </table>

      {/* Print-only: ALWAYS render the full list when printing, regardless
          of the on-screen toggle state. cc-print-only is a class we
          haven't defined yet — PrintStyles handles screen/print swap. */}
      {!showAll && hiddenCount > 0 && (
        <table className="cc-print-only" style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11, marginTop: -4 /* sit right under the on-screen table for clean print flow */ }}>
          <tbody>
            {vouchers.slice(50).map(v => (
              <VoucherBlock key={`${v.series}-${v.number}-print`} voucher={v} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function VoucherBlock({ voucher: v }: { voucher: VoucherDto }) {
  return (
    <>
      {/* Per-voucher header row */}
      <tr style={{ background: 'white' }}>
        <td style={{ ...td(), fontWeight: 500, paddingTop: 10, borderTop: `1px solid ${UXP.border}`, color: UXP.ink1 }}>
          {v.date}
        </td>
        <td style={{ ...td(), fontWeight: 600, paddingTop: 10, borderTop: `1px solid ${UXP.border}`, color: UXP.ink1, fontFamily: 'ui-monospace, monospace' }}>
          {v.series}&nbsp;{v.number}
        </td>
        <td style={{ ...td(), paddingTop: 10, borderTop: `1px solid ${UXP.border}` }} colSpan={4}>
          <span style={{ fontWeight: 500, color: UXP.ink2 }}>{v.description ?? '(ingen beskrivning)'}</span>
        </td>
      </tr>
      {/* Per-row #TRANS lines */}
      {v.rows.map((r, i) => (
        <tr key={i}>
          <td style={td()}></td>
          <td style={td()}></td>
          <td style={{ ...td(), fontFamily: 'ui-monospace, monospace' as const, color: UXP.ink2 }}>
            {r.account}
          </td>
          <td style={{ ...td(), color: UXP.ink3 }}>
            <span style={{ color: UXP.ink2 }}>{r.account_description}</span>
            {r.description && (
              <span style={{ color: UXP.ink4, marginLeft: 8, fontStyle: 'italic' as const }}>· {r.description}</span>
            )}
          </td>
          <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink2 }}>
            {r.debit  > 0 ? fmtKr(r.debit)  : ''}
          </td>
          <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink2 }}>
            {r.credit > 0 ? fmtKr(r.credit) : ''}
          </td>
        </tr>
      ))}
      {/* Per-voucher subtotal */}
      <tr style={{ background: UXP.subtleBg }}>
        <td style={td()}></td>
        <td style={td()}></td>
        <td style={td()}></td>
        <td style={{ ...td(), fontSize: 10, color: UXP.ink4, fontStyle: 'italic' as const }}>
          {v.rows.length} transaktion{v.rows.length === 1 ? '' : 'er'}
        </td>
        <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 500, color: UXP.ink2 }}>
          {fmtKr(v.debit_total)}
        </td>
        <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 500, color: UXP.ink2 }}>
          {fmtKr(v.credit_total)}
        </td>
      </tr>
    </>
  )
}

function TrendTable({ history, currentPeriod }: { history: HistoryRow[]; currentPeriod: { year: number; month: number } }) {
  // Sort oldest first for reading
  const sorted = [...history].sort((a, b) =>
    (a.period_year - b.period_year) || (a.period_month - b.period_month),
  )
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
      <thead>
        <tr style={{ color: UXP.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UXP.border}` }}>
          <th style={th()}>Period</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Omsättning</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Personal</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Råvaror</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Övrigt</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Resultat</th>
          <th style={{ ...th(), textAlign: 'right' as const }}>Marginal</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(r => {
          const isCurrent = r.period_year === currentPeriod.year && r.period_month === currentPeriod.month
          return (
            <tr
              key={`${r.period_year}-${r.period_month}`}
              style={{
                borderBottom: `0.5px solid ${UXP.borderSoft}`,
                background:   isCurrent ? UXP.lavFill : 'transparent',
                fontWeight:   isCurrent ? 600 : 400,
              }}
            >
              <td style={td()}>{MONTH_NAMES_SV[r.period_month - 1]} {r.period_year}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.revenue)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.staff_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.food_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(r.other_cost)}</td>
              <td style={{ ...td(), textAlign: 'right' as const, color: (r.net_profit ?? 0) >= 0 ? UXP.greenDeep : UXP.roseText }}>
                {fmtKr(r.net_profit)}
              </td>
              <td style={{ ...td(), textAlign: 'right' as const }}>
                {r.margin_pct != null ? Number(r.margin_pct).toFixed(1) + '%' : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: UXP.pageBg }}>
      <header style={{
        background:    'white',
        borderBottom:  `1px solid ${UXP.border}`,
        padding:       '12px 24px',
        display:       'flex',
        alignItems:    'center',
        justifyContent: 'space-between',
      }} className="cc-no-print">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: UXP.ink1 }}>CommandCenter</span>
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
            padding: '2px 6px', borderRadius: 3,
            background: UXP.lavFill, color: UXP.lavText,
          }}>REVISOR</span>
        </div>
        <button
          onClick={() => window.print()}
          style={{
            padding: '6px 12px', background: 'white',
            border: `1px solid ${UXP.border}`, borderRadius: 7,
            fontSize: 12, fontWeight: 500, color: UXP.ink2,
            cursor: 'pointer',
          }}
        >
          Skriv ut / PDF
        </button>
      </header>
      <main style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px 80px' }}>
        {children}
      </main>
    </div>
  )
}

// Bokföringslagen 7 kap. compliance: a printed monthly-close document
// must carry identifying business + period + system source + generation
// timestamp + page count on every page, and a currency declaration.
// Phase R1 of REVISOR-COMPLIANCE-PLAN.md.
//
// CSS @page runners (@top-left etc.) are populated via string content
// injected into a <style> tag at render time. The runners apply to
// every printed page automatically — no per-section markup needed.
// JS string escaping: CSS content() values are double-quoted, so any "
// in the business name gets backslash-escaped.
function PrintStyles({
  businessName, orgNumber, periodStart, periodEnd, periodLabel, generatedAt,
}: {
  businessName: string
  orgNumber:    string | null
  periodStart:  string                // YYYY-MM-DD
  periodEnd:    string                // YYYY-MM-DD
  periodLabel:  string                // e.g. "mars 2026"
  generatedAt:  string                // formatted local timestamp
}) {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const headerLeft  = orgNumber
    ? `${esc(businessName)} · Org.nr ${formatOrgNr(orgNumber)}`
    : esc(businessName)
  const headerRight = `Räkenskapsperiod ${periodStart} — ${periodEnd}`
  const footerLeft  = `Skapad ${esc(generatedAt)} av CommandCenter · commandcenter.se`
  const footerRight = 'Alla belopp i SEK om inget annat anges'

  return (
    <style>{`
      @page {
        size: A4 portrait;
        margin: 24mm 16mm 26mm 16mm;
        @top-left      { content: "${headerLeft}";  font-family: 'Spline Sans', system-ui, sans-serif; font-size: 9pt; color: #6b7280; }
        @top-right     { content: "${headerRight}"; font-family: 'Spline Sans', system-ui, sans-serif; font-size: 9pt; color: #6b7280; }
        @bottom-center { content: "Sida " counter(page) " av " counter(pages); font-family: 'Spline Sans', system-ui, sans-serif; font-size: 9pt; color: #6b7280; }
        @bottom-left   { content: "${footerLeft}";  font-family: 'Spline Sans', system-ui, sans-serif; font-size: 8pt; color: #9ca3af; }
        @bottom-right  { content: "${footerRight}"; font-family: 'Spline Sans', system-ui, sans-serif; font-size: 8pt; color: #9ca3af; }
      }
      /* Print-only elements: hidden on screen, visible on paper. The
         verifikationslista uses this to render its overflow rows in
         print without forcing the screen to scroll forever. */
      .cc-print-only { display: none; }
      @media print {
        .cc-no-print          { display: none !important; }
        .cc-print-only        { display: table !important; }   /* tables only */
        body                  { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .cc-revisor-content   { max-width: 100% !important; }
        /* Keep cards/sections from being split awkwardly across pages */
        section, .cc-revisor-section { break-inside: avoid; }
        /* Table rules: header rows repeat on every page; row breaks safely */
        table { page-break-inside: auto; }
        tr    { page-break-inside: avoid; page-break-after: auto; }
        thead { display: table-header-group; }
        tfoot { display: table-footer-group; }
        /* The compliance footer is always visible but doesn't need a page-
           break in print — it sits at the end of the document body. */
        .cc-compliance-footer { break-inside: avoid; }
      }
    `}</style>
  )
}

// Visible-everywhere compliance footer block. Sits at the end of the
// document body so it's the last thing on screen AND the last thing on
// the final printed page. Carries the legal acknowledgment that this
// summary is not itself the formal verifikationslista required by
// Bokföringslagen 5 kap. — that lives in the SIE export (Phase R2) or
// in the customer's Fortnox account.
function ComplianceFooter({
  businessName, tradingName, orgNumber, periodStart, periodEnd, generatedAt, sourceLabel,
}: {
  businessName: string                // legal entity name (e.g. "Aglianico i Örebro AB")
  tradingName:  string | null         // owner-set display name (e.g. "Chicce Slotsgatan"), only set when different from businessName
  orgNumber:    string | null
  periodStart:  string
  periodEnd:    string
  generatedAt:  string
  sourceLabel:  string                // 'Fortnox (manuellt avstämd)' | 'Manuellt inmatat' | etc.
}) {
  return (
    <section
      className="cc-compliance-footer"
      style={{
        marginTop:    24,
        paddingTop:   16,
        borderTop:    `1px solid ${UXP.border}`,
        fontSize:     10,
        color:        UXP.ink3,
        lineHeight:   1.7,
      }}
    >
      <div style={{ fontWeight: 600, color: UXP.ink2, marginBottom: 4 }}>
        Genererad av CommandCenter (commandcenter.se) · {generatedAt}
      </div>
      <div>
        <strong>Företag:</strong> {businessName}
        {orgNumber && <> · <strong>Org.nr:</strong> {formatOrgNr(orgNumber)}</>}
      </div>
      {tradingName && (
        <div>
          <strong>Verksamhet (handelsnamn):</strong> {tradingName}
        </div>
      )}
      <div>
        <strong>Räkenskapsperiod:</strong>{' '}
        <span style={{ whiteSpace: 'nowrap' as const }}>{periodStart}{' till '}{periodEnd}</span>
      </div>
      <div>
        <strong>Datakälla:</strong> {sourceLabel} · <strong>Valuta:</strong> SEK
      </div>
      <div style={{ marginTop: 6, fontSize: 9, color: UXP.ink4, fontStyle: 'italic' as const, lineHeight: 1.55 }}>
        Denna sammanställning utgör inte ersättning för formell verifikationslista per Bokföringslagen 5&nbsp;kap.
        {' '}För revisorsbruk: ladda ner SIE-fil eller använd Fortnox direkt för fullständig verifikationsåtkomst.
      </div>
    </section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background:   'white',
      border:       `1px solid ${UXP.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginBottom: 14,
    }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, margin: 0, marginBottom: 10 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const TONE: Record<string, string> = { good: UXP.greenDeep, warn: UXP.coral, bad: UXP.roseText, neutral: UXP.ink1 }
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: UXP.ink4, textTransform: 'uppercase' as const, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 500, color: TONE[tone] }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: UXP.greenFill, border: UXP.green,  fg: UXP.greenDeep },
    warn: { bg: UXP.lavFill,   border: UXP.lavMid, fg: UXP.coral     },
    bad:  { bg: UXP.roseFill,  border: UXP.rose,   fg: UXP.roseText  },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `0.5px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>{text}</div>
  )
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>{text}</div>
}
function th(): React.CSSProperties {
  return { padding: '8px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }
}
function td(): React.CSSProperties {
  return { padding: '8px 8px', verticalAlign: 'top' as const }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function pctOf(n: number | null | undefined, total: number | null | undefined): string | null {
  if (n == null || total == null || total === 0) return null
  return ((Number(n) / Number(total)) * 100).toFixed(1) + '% av oms.'
}
function formatOrgNr(s: string): string {
  const clean = s.replace(/\D/g, '')
  if (clean.length !== 10) return s
  return `${clean.slice(0, 6)}-${clean.slice(6)}`
}
function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
  } catch { return iso }
}

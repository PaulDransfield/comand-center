'use client'
// app/page.tsx — Public landing page, full rebuild
//
// Source of truth: commandcenter-landing.html in the repo root. That
// mockup is the design contract; this file is the React port. Every
// surface (hero, animated screen tour, problem card, how-it-works,
// platform grid, pricing, final CTA, footer) maps 1:1 to a section in
// the mockup.
//
// Palette: warm-paper backdrop + the same UXP lavender accent the app
// uses. Body type: Spline Sans (matches the app). Display: Fraunces.
//
// Auth flow preserved — Get started / Book a demo / Log in CTAs still
// route to /login. The previous i18n wiring is dropped on this page;
// the mockup's English is the canonical copy.

import { useEffect, useState } from 'react'
import Link from 'next/link'
// Language selector lives in the marketing nav so visitors can switch
// languages before signing up. Inline variant + light tone (paper bg).
import { LanguageSelector } from '@/components/LanguageSelector'

// ── Palette (matches commandcenter-landing.html :root) ─────────────
const C = {
  paper:    '#f4f1ea',
  paper2:   '#ece7db',
  ink:      '#26222e',
  ink2:     'rgba(38,34,46,0.62)',
  lav:      '#a99ce6',
  lavDeep:  '#7d6cc9',
  lavText:  '#564a8a',
  lavFill:  '#ece8f8',
  green:    '#5f9e7e',
  greenFill: '#eef4f0',
  coral:    '#c0703a',
  rose:     '#c06a72',
  line:     'rgba(38,34,46,0.1)',
  lineSoft: 'rgba(58,53,80,0.07)',
  card:     '#ffffff',
}

const F = {
  body:    `'Spline Sans', system-ui, -apple-system, sans-serif`,
  display: `'Fraunces', Georgia, serif`,
  mono:    `'DM Mono', 'Menlo', monospace`,
}

// ── Screen tour ── 8 screens auto-cycle every 4s ───────────────────
const TOUR_LABELS = ['Sales', 'Flash P&L', 'Cash', 'Labour', 'Reviews', 'Bookkeeping', 'Recipes', 'Scheduling']
const TOUR_DURATION = 4000

export default function LandingPage() {
  const [idx, setIdx]         = useState(0)
  const [playing, setPlaying] = useState(true)

  useEffect(() => {
    if (!playing) return
    const t = setTimeout(() => setIdx(i => (i + 1) % TOUR_LABELS.length), TOUR_DURATION)
    return () => clearTimeout(t)
  }, [idx, playing])

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Spline+Sans:wght@400;500;600&display=swap');
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html { scroll-behavior: smooth; }
        body {
          font-family: ${F.body};
          background: ${C.paper};
          color: ${C.ink};
          line-height: 1.6;
          -webkit-font-smoothing: antialiased;
          background-image: radial-gradient(circle at 1px 1px, rgba(38,34,46,0.025) 1px, transparent 0);
          background-size: 22px 22px;
        }
        a { text-decoration: none; color: inherit; }
        h1, h2, h3, .serif {
          font-family: ${F.display};
          font-weight: 500;
          letter-spacing: -0.02em;
          line-height: 1.05;
        }

        @keyframes ccFill { from { width: 0 } to { width: 100% } }
        .cc-pbar-fill {
          display: block; height: 100%; background: ${C.lavDeep};
          border-radius: 2px;
        }
        .cc-pbar-active .cc-pbar-fill { animation: ccFill 4s linear forwards; }
        .cc-pbar-done   .cc-pbar-fill { width: 100% !important; }

        @media (max-width: 880px) {
          .cc-hero        { grid-template-columns: 1fr !important; gap: 32px !important; }
          .cc-grid3       { grid-template-columns: 1fr !important; }
          .cc-navlinks    { display: none !important; }
          .cc-problem-pad { padding: 40px 28px !important; }
        }
      `}</style>

      {/* ── Nav ────────────────────────────────────────────────── */}
      <nav style={navStyle}>
        <Link href="/" style={logoStyle}>
          <span style={logoMark}>cc</span>
          <span style={{ fontFamily: F.display, fontSize: 19, fontWeight: 600 }}>CommandCenter</span>
        </Link>
        <div className="cc-navlinks" style={{ display: 'flex', gap: 30, alignItems: 'center', fontSize: 14, color: C.ink2 }}>
          <a href="#how"      style={{ color: 'inherit' }}>How it works</a>
          <a href="#platform" style={{ color: 'inherit' }}>Platform</a>
          <a href="#pricing"  style={{ color: 'inherit' }}>Pricing</a>
          <LanguageSelector variant="inline" onTone="light" />
          <Link href="/login" style={inkBtn}>Log in</Link>
          <Link href="/login?mode=signup&plan=founding" style={lavBtn}>Book a demo</Link>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────── */}
      <header className="cc-hero" style={{
        maxWidth:    1140,
        margin:      '0 auto',
        padding:     '54px 28px 30px',
        display:     'grid',
        gridTemplateColumns: '1fr 1.15fr',
        gap:         46,
        alignItems:  'center',
      }}>
        <div>
          <span style={eyebrow}>● Built in Stockholm, for Nordic operators</span>
          <h1 style={{ fontSize: 'clamp(38px, 5vw, 60px)', marginBottom: 20 }}>
            Know your numbers <em style={{ fontStyle: 'italic', color: C.lavDeep }}>before</em> the month is over.
          </h1>
          <p style={{ fontSize: 18, color: C.ink2, maxWidth: 450, marginBottom: 28 }}>
            CommandCenter reads your Fortnox, Personalkollen and POS data and turns it into the daily decisions that protect your margin — labour, food cost, cash, and what tomorrow will bring.
          </p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link href="/login?mode=signup&plan=founding" style={lavBtn}>Book a demo</Link>
            <a href="#how" style={{
              color: C.ink,
              fontSize: 14,
              fontWeight: 500,
              borderBottom: `1.5px solid ${C.lav}`,
              paddingBottom: 2,
            }}>See it in action ↓</a>
          </div>
          <div style={{ marginTop: 26, fontSize: 13, color: C.ink2 }}>
            Run by Nordic operators incl. <b style={{ color: C.ink, fontWeight: 600 }}>Vero Italiano</b> &amp; <b style={{ color: C.ink, fontWeight: 600 }}>Rosali Deli</b>, Örebro.
          </div>
        </div>

        <TourPlayer
          idx={idx}
          playing={playing}
          onTogglePlay={() => setPlaying(p => !p)}
          onPickBar={(n) => setIdx(n)}
        />
      </header>

      {/* ── Integrations marquee ───────────────────────────────── */}
      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '0 28px' }}>
        <div style={{
          padding:     '30px 0',
          borderTop:    `1px solid ${C.line}`,
          borderBottom: `1px solid ${C.line}`,
          marginTop:    30,
        }}>
          <p style={{
            textAlign: 'center', fontSize: 12, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: C.ink2, marginBottom: 16,
          }}>
            Native to the tools your restaurant already runs on
          </p>
          <div style={{
            display: 'flex', justifyContent: 'center', gap: 40, flexWrap: 'wrap',
            fontFamily: F.display, fontSize: 21, color: C.ink, opacity: 0.5,
          }}>
            <span>Fortnox</span>
            <span>Personalkollen</span>
            <span>Caspeco</span>
            <span>Onslip</span>
            <span>Google</span>
          </div>
        </div>
      </div>

      {/* ── Problem card ──────────────────────────────────────── */}
      <section style={{ maxWidth: 1140, margin: '0 auto', padding: '80px 28px 0' }}>
        <div className="cc-problem-pad" style={{
          background: C.ink,
          color:      C.paper,
          borderRadius: 20,
          padding:    '60px 56px',
          position:   'relative',
          overflow:   'hidden',
        }}>
          <div style={{
            position: 'absolute', right: -80, bottom: -100,
            width: 320, height: 320,
            background: `radial-gradient(circle, ${C.lavDeep}, transparent 70%)`,
            opacity: 0.35, pointerEvents: 'none',
          }} />
          <span style={{
            ...eyebrow,
            background: 'rgba(169,156,230,0.2)',
            color:      '#cdc3f2',
          }}>The problem</span>
          <h2 style={{ fontSize: 'clamp(26px, 3vw, 38px)', maxWidth: 640, marginTop: 16, marginBottom: 20, position: 'relative' }}>
            Most operators find out how a week went <em style={{ fontStyle: 'italic', color: C.lav }}>two weeks too late</em>.
          </h2>
          <p style={{ color: 'rgba(244,241,234,0.72)', maxWidth: 560, fontSize: 16.5, position: 'relative' }}>
            By the time the accountant closes the month, the overspend on labour, the supplier who quietly raised prices, the cash dip after rent — it's already happened. CommandCenter pulls it all together every morning, so you act while it still matters.
          </p>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────── */}
      <section id="how" style={{ maxWidth: 1140, margin: '0 auto', padding: '80px 28px 0' }}>
        <div style={{ maxWidth: 620, marginBottom: 46 }}>
          <span style={eyebrow}>How it works</span>
          <h2 style={{ fontSize: 'clamp(28px, 3.4vw, 40px)', marginTop: 16, marginBottom: 14 }}>
            Connect once. Then just open it every morning.
          </h2>
          <p style={{ fontSize: 17, color: C.ink2 }}>
            No spreadsheets, no data entry. It plugs into the systems you already use and does the reconciling for you.
          </p>
        </div>
        <div className="cc-grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 22, marginTop: 6 }}>
          {[
            { n: 1, title: 'Connect',    body: 'OAuth into Fortnox and Personalkollen, link your POS and Google. We pull 12 months of history on day one.' },
            { n: 2, title: 'Understand', body: 'Sales, margin, labour and cash — reconciled and explained. Every number comes with the why behind it.' },
            { n: 3, title: 'Act',        body: 'A Monday Memo, labour suggestions tied to forecast demand, flagged cost overruns, and a cash runway you can plan against.' },
          ].map(s => (
            <div key={s.n}>
              <div style={{
                fontFamily: F.display, fontSize: 15, color: C.lavDeep,
                background: C.lavFill, width: 34, height: 34, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14,
              }}>{s.n}</div>
              <h3 style={{ fontSize: 19, marginBottom: 8 }}>{s.title}</h3>
              <p style={{ fontSize: 14.5, color: C.ink2 }}>{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Platform grid ─────────────────────────────────────── */}
      <section id="platform" style={{ maxWidth: 1140, margin: '0 auto', padding: '80px 28px 0' }}>
        <div style={{ maxWidth: 620, marginBottom: 46 }}>
          <span style={eyebrow}>The platform</span>
          <h2 style={{ fontSize: 'clamp(28px, 3.4vw, 40px)', marginTop: 16, marginBottom: 14 }}>
            One brain for the whole operation.
          </h2>
          <p style={{ fontSize: 17, color: C.ink2 }}>
            From cash today to the cost of every plate. Everything below is built today — except the few we mark as on the way.
          </p>
        </div>
        <div className="cc-grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 22 }}>
          {[
            { ico: '📊', title: 'Sales & forecast',     body: 'Daily revenue, channels, and a forecast that grades itself against reality and explains every swing.' },
            { ico: '🧾', title: 'Flash P&L',            body: 'Live profit per location, by end of day — see which site made money and which one leaked it.' },
            { ico: '💰', title: 'Cash projection',      body: "Where your cash will be in 30 days, projected straight from your Fortnox transactions." },
            { ico: '👥', title: 'Labour',               body: "Cost of labour read first, kroner second — flagged when you're heading over target, before payroll." },
            { ico: '🏗️', title: 'Bookkeeping & costs',  body: 'Fortnox-deep: every invoice classified to the right BAS account, overruns and price rises flagged.' },
            { ico: '⭐', title: 'Reviews',              body: 'AI replies in your voice, cross-referenced against the shift that caused the complaint.' },
            { ico: '✦',  title: 'Ask CC',               body: 'Ask anything about your data in plain Swedish — and get an answer with the numbers behind it.' },
            { ico: '📦', title: 'Inventory & recipes',  body: 'Item master, recipe costings to the gram, and true food-cost reconciliation.', soon: true },
            { ico: '📅', title: 'AI scheduling',        body: 'Rotas built against forecast demand, written back to Personalkollen with owner sign-off.', soon: true },
          ].map((card, i) => (
            <div key={i} style={{
              background:   C.card,
              border:       `1px solid ${C.line}`,
              borderRadius: 14,
              padding:      26,
              transition:   'transform .2s',
              opacity:      card.soon ? 0.92 : 1,
            }}>
              <div style={{
                width: 42, height: 42, borderRadius: 11, background: C.lavFill,
                color: C.lavDeep, display: 'flex', alignItems: 'center',
                justifyContent: 'center', fontSize: 20, marginBottom: 16,
              }}>{card.ico}</div>
              <h3 style={{ fontSize: 20, marginBottom: 9 }}>
                {card.title}
                {card.soon && (
                  <span style={{
                    display: 'inline-block', fontSize: 10, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: C.coral,
                    background: 'rgba(192,112,58,0.12)', padding: '2px 8px',
                    borderRadius: 999, marginLeft: 8, verticalAlign: 'middle',
                  }}>Coming</span>
                )}
              </h3>
              <p style={{ fontSize: 14.5, color: C.ink2 }}>{card.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────── */}
      <section id="pricing" style={{ maxWidth: 1140, margin: '0 auto', padding: '80px 28px 0' }}>
        <div style={{ maxWidth: 620, marginBottom: 46 }}>
          <span style={eyebrow}>Pricing</span>
          <h2 style={{ fontSize: 'clamp(28px, 3.4vw, 40px)', marginTop: 16, marginBottom: 14 }}>
            One flat price per business.
          </h2>
          <p style={{ fontSize: 17, color: C.ink2 }}>
            Every feature included — no per-seat fees, no gated AI, no setup tricks. Same price for everyone, from day one.
          </p>
        </div>
        <div className="cc-grid3" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginTop: 10 }}>
          <PricingCard
            name="Solo"
            sub="A single restaurant"
            price="1 995 kr"
            features={['1 location', 'Sales, Flash P&L, labour & cash', 'Forecast & Monday Memo', 'Bookkeeping & cost flags', 'Reviews & Ask CC', 'Fortnox + Personalkollen']}
            ctaLabel="Get started"
            ctaHref="/login?mode=signup&plan=solo"
          />
          <PricingCard
            featured
            name="Group"
            sub="A small group"
            price="4 995 kr"
            features={['2–5 locations', 'Everything in Solo', 'Per-location Flash P&L', 'Cross-location benchmarks', 'Supplier cost intelligence', 'Team roles & permissions']}
            ctaLabel="Get started"
            ctaHref="/login?mode=signup&plan=group"
          />
          <PricingCard
            name="Chain"
            sub="Six locations and up"
            price="9 995 kr"
            features={['6+ locations', 'Everything in Group', 'Group-wide roll-up & ranking', 'Priority support', 'Accountant (revisor) access', 'Custom onboarding']}
            ctaLabel="Talk to us"
            ctaHref="/login?mode=signup&plan=chain"
          />
        </div>
        <p style={{ textAlign: 'center', fontSize: 13.5, color: C.ink2, marginTop: 22 }}>
          All plans include every shipped feature and the Ask CC assistant. Prices in SEK, excl. VAT.
        </p>
      </section>

      {/* ── Final CTA ──────────────────────────────────────────── */}
      <section style={{ maxWidth: 1140, margin: '0 auto', padding: '90px 28px 70px', textAlign: 'center' }}>
        <h2 style={{ fontSize: 'clamp(32px, 4vw, 50px)', marginBottom: 18 }}>
          Stop guessing. Start <em style={{ fontStyle: 'italic', color: C.lavDeep }}>knowing</em>.
        </h2>
        <p style={{ fontSize: 18, color: C.ink2, marginBottom: 28 }}>
          Book a 20-minute demo with the founder — an operator who built this for his own restaurants first.
        </p>
        <Link href="/login?mode=signup&plan=founding" style={{ ...lavBtn, padding: '14px 28px', fontSize: 16 }}>
          Book a demo
        </Link>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer style={{
        maxWidth: 1140, margin: '0 auto', padding: '34px 28px',
        borderTop: `1px solid ${C.line}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        fontSize: 13, color: C.ink2, flexWrap: 'wrap', gap: 14,
      }}>
        <Link href="/" style={logoStyle}>
          <span style={{ ...logoMark, width: 24, height: 24, fontSize: 13 }}>cc</span>
          <span style={{ fontFamily: F.display, fontSize: 16, fontWeight: 600 }}>CommandCenter</span>
        </Link>
        <div>© 2026 · comandcenter.se · Stockholm &amp; Örebro · Built by an operator</div>
      </footer>
    </>
  )
}

// ════════════════════════════════════════════════════════════════════
// Tour player
// ════════════════════════════════════════════════════════════════════

interface TourPlayerProps {
  idx:          number
  playing:      boolean
  onTogglePlay: () => void
  onPickBar:    (n: number) => void
}

function TourPlayer({ idx, playing, onTogglePlay, onPickBar }: TourPlayerProps) {
  return (
    <div style={{
      background:    '#fff',
      borderRadius:  16,
      boxShadow:     '0 30px 60px -24px rgba(38,34,46,0.3), 0 2px 0 rgba(255,255,255,0.6) inset',
      border:        `1px solid ${C.line}`,
      overflow:      'hidden',
    }}>
      {/* Browser-chrome bar */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        gap:          6,
        padding:      '10px 14px',
        background:   '#faf9f6',
        borderBottom: `1px solid ${C.line}`,
      }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e' }} />
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840' }} />
        <span style={{ marginLeft: 10, fontSize: 11, color: C.ink2, fontFamily: F.mono }}>
          app.comandcenter.se
        </span>
      </div>

      {/* Screens */}
      <div style={{
        position:     'relative',
        aspectRatio:  '16 / 10.4',
        background:   '#f1eff9',
        overflow:     'hidden',
      }}>
        {TOUR_SCREENS.map((Screen, i) => (
          <div
            key={i}
            style={{
              position:    'absolute',
              inset:       0,
              opacity:     i === idx ? 1 : 0,
              transition:  'opacity .6s ease',
              display:     'flex',
              flexDirection: 'column',
              pointerEvents: i === idx ? 'auto' : 'none',
            }}
          >
            <Screen />
          </div>
        ))}
      </div>

      {/* Progress bars */}
      <div style={{
        display: 'flex', gap: 5,
        padding: '11px 14px', background: '#faf9f6',
        borderTop: `1px solid ${C.line}`,
      }}>
        {TOUR_LABELS.map((_, i) => {
          const state = i === idx ? (playing ? 'active' : 'done') : i < idx ? 'done' : 'idle'
          return (
            <div
              key={i}
              onClick={() => onPickBar(i)}
              className={state === 'active' ? 'cc-pbar-active' : state === 'done' ? 'cc-pbar-done' : ''}
              style={{
                flex: 1, height: 3, background: C.paper2,
                borderRadius: 2, overflow: 'hidden', cursor: 'pointer',
              }}
            >
              <span className="cc-pbar-fill" />
            </div>
          )
        })}
      </div>

      {/* Play / pause + label */}
      <div style={{
        display:     'flex',
        alignItems:  'center',
        gap:         10,
        padding:     '0 14px 11px',
        background:  '#faf9f6',
        fontSize:    11,
        color:       C.ink2,
      }}>
        <button
          type="button"
          onClick={onTogglePlay}
          style={{
            background: 'none',
            border:     'none',
            cursor:     'pointer',
            color:      C.ink,
            fontSize:   13,
            display:    'flex',
            alignItems: 'center',
            gap:        5,
            fontFamily: 'inherit',
          }}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <span>{TOUR_LABELS[idx]}</span>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// 8 tour screens — direct ports of the mockup's .screen blocks
// ════════════════════════════════════════════════════════════════════

function ScreenShell({ chips, title, children, caption, captionIco }: any) {
  return (
    <>
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column' as const,
        background: '#f1eff9', fontSize: 9, color: '#3a3550',
      }}>
        <div style={{
          display: 'flex', gap: 5,
          padding: '7px 10px',
          borderBottom: `1px solid ${C.lineSoft}`,
          alignItems: 'center',
        }}>
          {chips.map((c: any, i: number) => (
            <span key={i} style={{
              background: c.lav ? C.lav : '#fff',
              color:      c.lav ? '#fff' : '#3a3550',
              border:     c.lav ? `1px solid ${C.lav}` : `1px solid rgba(58,53,80,0.1)`,
              borderRadius: 5, padding: '3px 7px', fontSize: 8.5,
              marginLeft: c.lav ? 'auto' : undefined,
            }}>{c.text}</span>
          ))}
        </div>
        <div style={{ padding: 10, flex: 1 }}>
          <div style={{ fontFamily: F.display, fontSize: 14, fontWeight: 500, marginBottom: 9 }}>
            {title}
          </div>
          {children}
        </div>
      </div>
      <div style={{
        position: 'absolute', left: 14, right: 14, bottom: 14,
        background: 'rgba(38,34,46,0.92)', color: '#fff',
        borderRadius: 10, padding: '11px 15px',
        fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 9,
        backdropFilter: 'blur(4px)',
      }}>
        <span style={{
          width: 22, height: 22, borderRadius: 6, background: C.lav,
          flexShrink: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 12,
        }}>{captionIco}</span>
        {caption}
      </div>
    </>
  )
}

function Kpi({ label, value, color, bar, barBg }: any) {
  return (
    <div style={{ flex: 1, background: '#fff', borderRadius: 9, padding: '9px 10px' }}>
      <div style={{ fontSize: 8, color: 'rgba(58,53,80,0.55)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: F.display, color: color ?? '#3a3550' }}>{value}</div>
      {bar != null && (
        <div style={{ height: 6, background: '#efedf8', borderRadius: 3, marginTop: 7, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${bar}%`, background: barBg ?? C.lav }} />
        </div>
      )}
    </div>
  )
}

function BarsRow({ bars }: { bars: Array<{ a: number; b: number }> }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 74, paddingTop: 6 }}>
      {bars.map((g, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%' }}>
          <span style={{ flex: 1, borderRadius: '2px 2px 0 0', height: `${g.a}%`, background: C.lav }} />
          <span style={{ flex: 1, borderRadius: '2px 2px 0 0', height: `${g.b}%`, background: '#d8d2f0' }} />
        </div>
      ))}
    </div>
  )
}

function Row({ label, value, kind, highlight }: any) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '5px 0',
      borderBottom: `1px solid ${C.lineSoft}`,
      fontSize: 9,
      background: highlight ? '#f4f2fa' : undefined,
      margin: highlight ? '0 -4px' : undefined,
      borderRadius: highlight ? 4 : undefined,
      paddingLeft: highlight ? 4 : undefined,
      paddingRight: highlight ? 4 : undefined,
    }}>
      <span>{label}</span>
      <span style={{
        color: kind === 'pos' ? C.green
             : kind === 'neg' ? C.rose
             : kind === 'amber' ? '#b0883c'
             : kind === 'muted' ? C.ink2
             : '#3a3550',
      }}>{value}</span>
    </div>
  )
}

// ── Tour screen components ───────────────────────────────────────
const SalesScreen = () => (
  <ScreenShell
    chips={[{ text: 'Insights ▾' }, { text: 'Sales ▾' }, { text: '19–25 May' }, { text: '✦ Ask CC', lav: true }]}
    title="Sales — Vero Italiano"
    captionIco="📊"
    caption="Every channel, every day — actual vs forecast, at a glance."
  >
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <Kpi label="Revenue"      value={<span>487 240 kr <span style={{ fontSize: 9, color: C.green }}>↗ 8,2%</span></span>} bar={84} />
      <Kpi label="Gross margin" value="68,1%" bar={68} barBg={C.green} />
      <Kpi label="Labour"       value="32,4%" color={C.green} bar={32} barBg={C.green} />
    </div>
    <div style={{ background: '#fff', borderRadius: 9, padding: 11 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 9 }}>Sales v forecast</div>
      <BarsRow bars={[{ a: 42, b: 46 }, { a: 50, b: 52 }, { a: 55, b: 58 }, { a: 62, b: 60 }, { a: 86, b: 80 }, { a: 100, b: 92 }, { a: 4, b: 4 }]} />
    </div>
  </ScreenShell>
)

const FlashPlScreen = () => (
  <ScreenShell
    chips={[{ text: 'Insights ▾' }, { text: 'Flash P&L ▾' }, { text: 'Best · Worst · All' }, { text: '✦ Ask CC', lav: true }]}
    title="Flash P&L"
    captionIco="🧾"
    caption="A live P&L per location — profit by end of day, not end of month."
  >
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ flex: 1, background: '#fff', borderRadius: 9, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9.5 }}>Vero Italiano</div>
        <Row label={<>Sales <span style={{ color: C.green }}>↗8%</span></>} value="487 240 kr" />
        <Row label={<>CoGS <span style={{ color: C.rose }}>↗6%</span></>}  value={<>155 369 <span style={{ fontSize: 9, color: C.ink2 }}>31,9%</span></>} />
        <Row label={<>Labour <span style={{ color: C.green }}>↘5%</span></>} value={<span style={{ color: C.green }}>157 866 <span style={{ fontSize: 9 }}>32,4%</span></span>} />
        <Row label="Flash profit" value={<span style={{ color: C.lavText, fontWeight: 600 }}>62 480 kr</span>} />
      </div>
      <div style={{ flex: 1, background: '#fff', borderRadius: 9, padding: 10, border: `1.5px solid rgba(95,158,126,0.5)` }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9.5 }}>Rosali Deli</div>
        <Row label={<>Sales <span style={{ color: C.green }}>↗1%</span></>} value="128 470 kr" />
        <Row label={<>CoGS <span style={{ color: C.rose }}>↗5%</span></>}  value={<>37 256 <span style={{ fontSize: 9, color: C.ink2 }}>29%</span></>} />
        <Row label={<>Labour <span style={{ color: C.green }}>↘3%</span></>} value={<span style={{ color: C.green }}>35 968 <span style={{ fontSize: 9 }}>28%</span></span>} />
        <Row label="Flash profit" value={<span style={{ color: C.lavText, fontWeight: 600 }}>55 246 kr</span>} />
      </div>
    </div>
  </ScreenShell>
)

const CashScreen = () => (
  <ScreenShell
    chips={[{ text: 'Insights ▾' }, { text: 'Cash ▾' }, { text: 'Next 30 days' }, { text: '✦ Ask CC', lav: true }]}
    title="Cash position"
    captionIco="💰"
    caption="See your cash 30 days out — the view your accounting software won't give you."
  >
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <Kpi label="Today"        value="312 400 kr" />
      <Kpi label="In 30 days"   value="468 900 kr" color={C.green} />
      <Kpi label="Lowest point" value="286 100 kr" />
    </div>
    <div style={{ background: '#fff', borderRadius: 9, padding: 11 }}>
      <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9 }}>Projected from your Fortnox transactions</div>
      <svg viewBox="0 0 320 70" style={{ width: '100%', height: 70 }}>
        <polyline points="6,46 70,42 130,44 190,38 210,36" fill="none" stroke={C.lavDeep} strokeWidth="2.5" />
        <polyline points="210,36 250,28 280,46 310,22" fill="none" stroke={C.lav} strokeWidth="2" strokeDasharray="4,3" />
        <circle cx="210" cy="36" r="4" fill={C.lavDeep} />
      </svg>
    </div>
  </ScreenShell>
)

const LabourScreen = () => (
  <ScreenShell
    chips={[{ text: 'Insights ▾' }, { text: 'Labour ▾' }, { text: '% · kr · h' }, { text: '✦ Ask CC', lav: true }]}
    title="Labour — All locations"
    captionIco="👥"
    caption="Labour read first, kroner second — exactly how you think about a shift."
  >
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <Kpi label="Sales"          value="487 240" />
      <Kpi label="Actual labour"  value="32,4%" color={C.green} />
      <Kpi label="Projected"      value="38,2%" color={C.rose} />
    </div>
    <div style={{ background: '#fff', borderRadius: 9, padding: 11 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 9 }}>Labour over time</div>
      <BarsRow bars={[{ a: 48, b: 42 }, { a: 40, b: 36 }, { a: 20, b: 24 }, { a: 80, b: 84 }, { a: 66, b: 70 }, { a: 52, b: 56 }, { a: 60, b: 64 }]} />
    </div>
  </ScreenShell>
)

const ReviewsScreen = () => (
  <ScreenShell
    chips={[{ text: 'Insights ▾' }, { text: 'Reviews ▾' }, { text: 'Google' }, { text: '✦ Ask CC', lav: true }]}
    title="Customer reviews"
    captionIco="⭐"
    caption="AI replies in your voice — and tells you why the review happened."
  >
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <Kpi label="Rating"      value="4,6 ★" />
      <Kpi label="Replied"     value="93%" />
      <Kpi label="Needs reply" value="2" color={C.coral} />
    </div>
    <div style={{ background: '#fff', borderRadius: 9, padding: 11 }}>
      <div style={{ fontSize: 9, color: C.lavText, marginBottom: 4 }}>✦ OPERATIONAL INSIGHT</div>
      <div style={{ fontSize: 9.5, lineHeight: 1.5, color: '#3a3550', marginBottom: 8 }}>
        "Slow service Friday night" — matches the data: you ran 1 server short Fri 20:00–22:00.
      </div>
      <div style={{
        background: '#faf9fd', border: '1px solid rgba(58,53,80,0.08)',
        borderRadius: 7, padding: 7, fontSize: 9, fontStyle: 'italic' as const, color: C.ink2,
      }}>
        Tack Johan! Tråkigt att väntan blev lång — vi ser över bemanningen på fredagskvällar…
      </div>
    </div>
  </ScreenShell>
)

const BookkeepingScreen = () => (
  <ScreenShell
    chips={[{ text: 'Bookkeeping ▾' }, { text: 'Overheads ▾' }, { text: '✦ Ask CC', lav: true }]}
    title="Flagged costs"
    captionIco="🏗️"
    caption="Fortnox-deep: every cost classified to the right BAS account, overruns flagged."
  >
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ flex: 0.9, background: '#fff', borderRadius: 9, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9.5 }}>Flags</div>
        <Row label={<><b>El — Fortum</b></>} value="+34%" kind="neg" highlight />
        <Row label="Försäkring — IF"          value="ny"    kind="amber" />
        <Row label="Internet — Telia"         value="?"     kind="muted" />
      </div>
      <div style={{ flex: 1, background: '#fff', borderRadius: 9, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9.5 }}>El — Fortum</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 7 }}>
          <span style={{ fontSize: 8, color: 'rgba(58,53,80,0.5)' }}>Belopp<br /><b style={{ fontSize: 12, color: '#3a3550' }}>14 280</b></span>
          <span style={{ fontSize: 8, color: 'rgba(58,53,80,0.5)', textAlign: 'right' as const }}>Snitt<br /><b style={{ fontSize: 12 }}>10 650</b></span>
        </div>
        <div style={{ background: '#faf9fd', borderRadius: 6, padding: 6, fontSize: 8.5, color: C.lavText, marginBottom: 7 }}>
          ✦ Klassas <b>5020 · El</b>. Matchar kall april — säsong, inte fel.
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          <span style={{ background: '#3a3550', color: '#fff', borderRadius: 5, padding: '4px 10px', fontSize: 8.5 }}>Bekräfta</span>
          <span style={{ border: '1px solid rgba(58,53,80,0.15)', borderRadius: 5, padding: '4px 10px', fontSize: 8.5 }}>PDF</span>
        </div>
      </div>
    </div>
  </ScreenShell>
)

const RecipesScreen = () => (
  <ScreenShell
    chips={[{ text: 'Inventory ▾' }, { text: 'Recipes ▾' }, { text: 'On the roadmap' }]}
    title="Recipe costings"
    captionIco="🍝"
    caption="Every dish costed to the gram — true margin, plate by plate."
  >
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ flex: 1.3, background: '#fff', borderRadius: 9, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9.5 }}>Menu</div>
        <Row label="Tagliatelle tartufo" value="74,6%" kind="pos" />
        <Row label="Pizza margherita"    value="78,6%" kind="pos" />
        <Row label="Burrata starter"     value="66,7%" kind="amber" />
      </div>
      <div style={{ flex: 1, background: '#fff', borderRadius: 9, padding: 10 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 9.5 }}>Tagliatelle tartufo</div>
        <div style={{
          background: C.greenFill, borderRadius: 6, padding: 7, marginBottom: 7,
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 8, color: 'rgba(58,53,80,0.55)' }}>Cost<br /><b style={{ fontSize: 12, color: '#3a3550' }}>48 kr</b></span>
          <span style={{ fontSize: 8, color: '#477f60', textAlign: 'right' as const }}>GP 74,6%<br /><b style={{ fontSize: 12 }}>121 kr</b></span>
        </div>
        <Row label="Tagliatelle 0,18kg" value="14 kr" />
        <Row label="Tryffel 0,008kg"    value="22 kr" />
      </div>
    </div>
  </ScreenShell>
)

const SchedulingScreen = () => (
  <ScreenShell
    chips={[{ text: 'Schedule ▾' }, { text: 'Week 22' }, { text: 'On the roadmap' }]}
    title="Your plan vs AI applied"
    captionIco="📅"
    caption="Builds the rota against forecast demand — then writes it to Personalkollen."
  >
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <Kpi label="Your plan"        value="38,2%" color={C.rose} />
      <div style={{ flex: 1, background: '#fff', borderRadius: 9, padding: '9px 10px', border: '1.5px solid rgba(169,156,230,0.5)' }}>
        <div style={{ fontSize: 8, color: 'rgba(58,53,80,0.55)', marginBottom: 4 }}>With AI applied</div>
        <div style={{ fontSize: 15, fontWeight: 600, fontFamily: F.display, color: C.green }}>32,9%</div>
      </div>
      <div style={{ flex: 1, background: C.lavFill, borderRadius: 9, padding: '9px 10px' }}>
        <div style={{ fontSize: 8, color: C.lavText, marginBottom: 4 }}>You save</div>
        <div style={{ fontSize: 15, fontWeight: 600, fontFamily: F.display, color: C.lavText }}>25 810 kr</div>
      </div>
    </div>
    <div style={{ background: '#fff', borderRadius: 9, padding: 11 }}>
      <Row label={<><b>Sun 25</b> — closed for Pingst, full cut</>} value="−9 400 kr" kind="pos" />
      <Row label={<><b>Sat 24</b> — peak 20:00, add a chef</>}      value={<span style={{ color: C.coral }}>+640 kr</span>} highlight />
    </div>
  </ScreenShell>
)

const TOUR_SCREENS = [SalesScreen, FlashPlScreen, CashScreen, LabourScreen, ReviewsScreen, BookkeepingScreen, RecipesScreen, SchedulingScreen]

// ════════════════════════════════════════════════════════════════════
// Pricing card
// ════════════════════════════════════════════════════════════════════

function PricingCard({ name, sub, price, features, ctaLabel, ctaHref, featured }: any) {
  return (
    <div style={{
      background:    C.card,
      border:        featured ? `1.5px solid ${C.lav}` : `1px solid ${C.line}`,
      borderRadius:  16,
      padding:       30,
      display:       'flex',
      flexDirection: 'column' as const,
      boxShadow:     featured ? '0 20px 40px -20px rgba(169,156,230,0.5)' : undefined,
      position:      'relative' as const,
    }}>
      {featured && (
        <span style={{
          position:     'absolute',
          top:          -11,
          left:         30,
          background:   C.lavDeep,
          color:        '#fff',
          fontSize:     11,
          padding:      '3px 10px',
          borderRadius: 999,
        }}>Most popular</span>
      )}
      <div style={{ fontSize: 14, color: C.ink2, marginBottom: 4 }}>{name}</div>
      <div style={{ fontSize: 12.5, color: C.ink2, marginBottom: 14 }}>{sub}</div>
      <div style={{ fontFamily: F.display, fontSize: 34, fontWeight: 500, lineHeight: 1 }}>
        {price}<small style={{ fontSize: 14, color: C.ink2, fontWeight: 400, fontFamily: F.body }}> / mo</small>
      </div>
      <ul style={{ listStyle: 'none', margin: '18px 0 22px', flex: 1, padding: 0 }}>
        {features.map((f: string, i: number) => (
          <li key={i} style={{ fontSize: 14, padding: '6px 0', color: C.ink2, display: 'flex', gap: 8 }}>
            <span style={{ color: C.lavDeep }}>→</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link href={ctaHref} style={{
        ...(featured ? lavBtn : inkBtn),
        width:      '100%',
        textAlign:  'center' as const,
        display:    'inline-block',
      }}>{ctaLabel}</Link>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════
// Shared styles
// ════════════════════════════════════════════════════════════════════

const navStyle: React.CSSProperties = {
  display:        'flex',
  alignItems:     'center',
  justifyContent: 'space-between',
  padding:        '22px 28px',
  maxWidth:       1140,
  margin:         '0 auto',
}

const logoStyle: React.CSSProperties = {
  display:    'flex',
  alignItems: 'center',
  gap:        9,
  fontFamily: F.display,
  fontSize:   19,
  fontWeight: 600,
  color:      C.ink,
}

const logoMark: React.CSSProperties = {
  width:        30,
  height:       30,
  background:   C.lav,
  borderRadius: 8,
  display:      'flex',
  alignItems:   'center',
  justifyContent: 'center',
  color:        '#fff',
  fontSize:     16,
  fontWeight:   600,
  fontFamily:   F.body,
}

const eyebrow: React.CSSProperties = {
  display:       'inline-flex',
  alignItems:    'center',
  gap:           7,
  fontSize:      12.5,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  color:         C.lavText,
  background:    C.lavFill,
  padding:       '6px 12px',
  borderRadius:  999,
  marginBottom:  22,
}

const inkBtn: React.CSSProperties = {
  background:   C.ink,
  color:        C.paper,
  padding:      '10px 18px',
  borderRadius: 9,
  fontSize:     14,
  fontWeight:   500,
  textDecoration: 'none',
  border:       'none',
  cursor:       'pointer',
  display:      'inline-block',
}

const lavBtn: React.CSSProperties = {
  background:   C.lavDeep,
  color:        '#fff',
  padding:      '10px 18px',
  borderRadius: 9,
  fontSize:     14,
  fontWeight:   500,
  textDecoration: 'none',
  border:       'none',
  cursor:       'pointer',
  display:      'inline-block',
}

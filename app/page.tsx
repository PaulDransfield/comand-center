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

export default function LandingPage() {
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

        @media (max-width: 880px) {
          .cc-hero        { grid-template-columns: 1fr !important; gap: 32px !important; }
          .cc-grid3       { grid-template-columns: 1fr !important; }
          .cc-navlinks    { gap: 10px !important; }
          .cc-nav-anchor  { display: none !important; }
          .cc-problem-pad { padding: 40px 28px !important; }
          /* Phone header — tighten container padding + button padding so
             the wordmark + both CTAs sit cleanly inside the viewport
             without overlap or right-edge clipping. */
          .cc-nav         { padding: 16px 14px !important; }
          .cc-nav-btn     { padding: 8px 12px !important; }
        }
        /* Narrowest phones (iPhone SE etc.) — shave a touch more so the
           full "Book a demo" label stays on one line. Wordmark sized
           down only at this breakpoint. */
        @media (max-width: 380px) {
          .cc-wordmark    { font-size: 16px !important; }
          .cc-nav-btn     { padding: 7px 10px !important; font-size: 13px !important; }
          .cc-navlinks    { gap: 8px !important; }
        }
      `}</style>

      {/* ── Nav ────────────────────────────────────────────────── */}
      <nav className="cc-nav" style={navStyle}>
        <Link href="/" style={logoStyle}>
          <span style={logoMark}>cc</span>
          <span className="cc-wordmark" style={{ fontFamily: F.display, fontSize: 19, fontWeight: 600 }}>CommandCenter</span>
        </Link>
        <div className="cc-navlinks" style={{ display: 'flex', gap: 30, alignItems: 'center', fontSize: 14, color: C.ink2 }}>
          <a href="#how"      className="cc-nav-anchor" style={{ color: 'inherit' }}>How it works</a>
          <a href="#platform" className="cc-nav-anchor" style={{ color: 'inherit' }}>Platform</a>
          <a href="#pricing"  className="cc-nav-anchor" style={{ color: 'inherit' }}>Pricing</a>
          <span className="cc-nav-anchor"><LanguageSelector variant="inline" onTone="light" /></span>
          <Link href="/login" className="cc-nav-btn" style={lavOutlineBtn}>Log in</Link>
          <Link href="/login?mode=signup&plan=founding" className="cc-nav-btn" style={lavBtn}>Book a demo</Link>
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

        <TourPlayer />
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
          {([
            { ico: '📊', title: 'Sales & forecast',     body: 'Daily revenue, channels, and a forecast that grades itself against reality and explains every swing.' },
            { ico: '🧾', title: 'Flash P&L',            body: 'Live profit per location, by end of day — see which site made money and which one leaked it.' },
            { ico: '💰', title: 'Cash projection',      body: "Where your cash will be in 30 days, projected straight from your Fortnox transactions." },
            { ico: '👥', title: 'Labour',               body: "Cost of labour read first, kroner second — flagged when you're heading over target, before payroll." },
            { ico: '🏗️', title: 'Bookkeeping & costs',  body: 'Fortnox-deep: every invoice classified to the right BAS account, overruns and price rises flagged.' },
            { ico: '⭐', title: 'Reviews',              body: 'AI replies in your voice, cross-referenced against the shift that caused the complaint.' },
            { ico: '✦',  title: 'Ask CC',               body: 'Ask anything about your data in plain Swedish — and get an answer with the numbers behind it.' },
            { ico: '📦', title: 'Inventory & recipes',  body: 'Item master, recipe costings to the gram, and true food-cost reconciliation.' },
            { ico: '📅', title: 'AI scheduling',        body: 'Rotas built against forecast demand, with AI suggestions to trim over-staffed shifts — you review and apply them in Personalkollen.' },
          ] as { ico: string; title: string; body: string; soon?: boolean }[]).map((card, i) => (
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

// Looping product-promo video inside a faux-browser frame. Muted +
// playsInline + autoPlay together satisfy every modern browser's
// autoplay policy (Chrome / Safari / Firefox / mobile). `loop` keeps
// it cycling forever. No user controls — visitors can scroll or
// click through to /login if they want more.
function TourPlayer() {
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

      {/* Promo video */}
      <video
        src="/commandcenter-promo.mp4"
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        style={{
          display:    'block',
          width:      '100%',
          aspectRatio: '16 / 10.4',
          objectFit:  'cover',
          background: '#f1eff9',
        }}
      />
    </div>
  )
}

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
  whiteSpace:   'nowrap',
}

// Secondary Log-in button — lavender-family to match the rest of the
// scheme (the dark ink fill clashed with the paper backdrop + the lav
// "Book a demo" primary CTA). Same shape + padding as lavBtn so the
// pair reads as a system.
const lavOutlineBtn: React.CSSProperties = {
  background:   C.lavFill,
  color:        C.lavText,
  padding:      '10px 18px',
  borderRadius: 9,
  fontSize:     14,
  fontWeight:   500,
  textDecoration: 'none',
  border:       `0.5px solid ${C.lav}`,
  cursor:       'pointer',
  display:      'inline-block',
  whiteSpace:   'nowrap',
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
  whiteSpace:   'nowrap',
}

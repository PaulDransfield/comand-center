// app/page.tsx — Public landing page
// Shown to all visitors at comandcenter.se
// Logged-in users see the nav link to dashboard; logged-out users see login/signup CTAs

import Link from 'next/link'

export const metadata = {
  title: 'CommandCenter — Restaurant Intelligence for Swedish Restaurants',
  description: 'AI-powered business intelligence for Swedish restaurant groups. Bring every system your business runs on into one place, and let AI make sense of the numbers so you can see what really matters.',
}

// ── DESIGN TOKENS (matching nextjs/app/globals.css) ───────────
const C = {
  navy:      '#1E2761',
  navyDeep:  '#161d4e',
  blue:      '#185FA5',
  blueLt:    '#EEF4FF',
  parchment: '#F2EDE8',
  offWhite:  '#FAFAF8',
  white:     '#FFFFFF',
  border:    '#E0DAD2',
  borderD:   '#C8C1B8',
  ink:       '#1C1714',
  ink2:      '#3A3733',
  ink3:      '#6A6560',
  ink4:      '#A8A49C',
  green:     '#2D6A35',
  greenLt:   '#EAF2E8',
  amber:     '#7A4800',
  amberLt:   '#FFF5E5',
}

const F = {
  body:    `'DM Sans', system-ui, -apple-system, sans-serif`,
  display: `'Fraunces', Georgia, serif`,
  mono:    `'DM Mono', 'Menlo', monospace`,
}

export default function LandingPage() {
  return (
    <>
      {/* ── Google Fonts ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,400;0,9..144,500;1,9..144,300;1,9..144,400&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow-x: hidden; max-width: 100vw; }
        body { font-family: ${F.body}; color: ${C.ink}; background: ${C.offWhite}; -webkit-font-smoothing: antialiased; }
        a { text-decoration: none; color: inherit; }

        /* ── Nav ── */
        .nav-link { font-size: 14px; color: rgba(255,255,255,.75); transition: color .15s; }
        .nav-link:hover { color: white; }

        /* ── Buttons ── */
        .btn-white {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 11px 22px; border-radius: 10px; font-family: ${F.body};
          font-size: 14px; font-weight: 600; cursor: pointer; transition: all .15s;
          background: white; color: ${C.navy}; border: none;
        }
        .btn-white:hover { background: ${C.parchment}; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(0,0,0,.15); }

        .btn-outline-white {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 11px 22px; border-radius: 10px; font-family: ${F.body};
          font-size: 14px; font-weight: 500; cursor: pointer; transition: all .15s;
          background: transparent; color: rgba(255,255,255,.9); border: 1.5px solid rgba(255,255,255,.3);
        }
        .btn-outline-white:hover { border-color: rgba(255,255,255,.7); background: rgba(255,255,255,.08); }

        .btn-navy {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 12px 24px; border-radius: 10px; font-family: ${F.body};
          font-size: 15px; font-weight: 600; cursor: pointer; transition: all .15s;
          background: ${C.navy}; color: white; border: none;
        }
        .btn-navy:hover { background: ${C.navyDeep}; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(30,39,97,.3); }

        .btn-outline-navy {
          display: inline-flex; align-items: center; gap: 6px;
          padding: 12px 24px; border-radius: 10px; font-family: ${F.body};
          font-size: 15px; font-weight: 500; cursor: pointer; transition: all .15s;
          background: transparent; color: ${C.navy}; border: 1.5px solid ${C.borderD};
        }
        .btn-outline-navy:hover { border-color: ${C.navy}; background: ${C.blueLt}; }

        /* ── Feature cards ── */
        .feature-card {
          background: white; border: 1px solid ${C.border}; border-radius: 16px;
          padding: 28px; transition: box-shadow .2s, transform .2s;
        }
        .feature-card:hover { box-shadow: 0 8px 32px rgba(0,0,0,.08); transform: translateY(-2px); }

        /* ── Pricing cards ── */
        .pricing-card {
          background: white; border: 1.5px solid ${C.border}; border-radius: 20px;
          padding: 32px; display: flex; flex-direction: column; gap: 8px;
        }
        .pricing-card.featured {
          background: ${C.navy}; border-color: ${C.navy}; color: white;
        }

        /* ── Integration pill ── */
        .integration-pill {
          display: flex; align-items: center; gap: 10px;
          background: white; border: 1px solid ${C.border}; border-radius: 12px;
          padding: 12px 20px; font-size: 14px; font-weight: 500;
          transition: box-shadow .15s;
        }
        .integration-pill:hover { box-shadow: 0 4px 16px rgba(0,0,0,.08); }

        /* ── Footer links ── */
        .footer-link { font-size: 13px; color: rgba(255,255,255,.55); transition: color .15s; }
        .footer-link:hover { color: white; }

        /* ── Responsive ── */
        @media (max-width: 768px) {
          .hero-btns { flex-direction: column; align-items: stretch; }
          .hero-btns a { justify-content: center; }
          .features-grid { grid-template-columns: 1fr !important; }
          .pricing-grid { grid-template-columns: 1fr !important; }
          .integrations-row { flex-direction: column; }
          .nav-links { display: none; }
          .footer-grid { grid-template-columns: 1fr !important; gap: 32px !important; }
          .hero-headline { font-size: clamp(32px, 8vw, 52px) !important; }
          .stat-row { flex-wrap: wrap; gap: 24px !important; }
        }
        /* Extra-small phones: shrink nav so the logo + CTA fit at 320–400px */
        @media (max-width: 480px) {
          .nav-logo-text { display: none; }
          .nav-cta-login { display: none; }
          .nav-cta-trial { padding: 7px 14px !important; font-size: 12px !important; }
          nav > div { padding: 0 16px !important; }
          section { padding-left: 16px !important; padding-right: 16px !important; }
        }
      `}</style>

      {/* ════════════════════════════════════════════════════════
          NAV
      ════════════════════════════════════════════════════════ */}
      <nav style={{
        background: C.navy,
        position: 'sticky', top: 0, zIndex: 100,
        borderBottom: '1px solid rgba(255,255,255,.08)',
      }}>
        <div style={{
          maxWidth: 1100, margin: '0 auto', padding: '0 24px',
          height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          {/* Logo */}
          <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, background: 'rgba(255,255,255,.15)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <span className="nav-logo-text" style={{ fontFamily: F.display, fontSize: 16, color: 'white', fontWeight: 400 }}>
              CommandCenter
            </span>
          </Link>

          {/* Nav links */}
          <div className="nav-links" style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
            <a href="#features" className="nav-link">Features</a>
            <a href="#integrations" className="nav-link">Integrations</a>
            <a href="#pricing" className="nav-link">Pricing</a>
          </div>

          {/* CTAs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Link href="/login" className="btn-outline-white nav-cta-login" style={{ padding: '8px 18px', fontSize: 13 }}>
              Log in
            </Link>
            <Link href="/login?mode=signup&plan=founding" className="btn-white nav-cta-trial" style={{ padding: '8px 18px', fontSize: 13 }}>
              Get started
            </Link>
          </div>
        </div>
      </nav>

      {/* ════════════════════════════════════════════════════════
          HERO
      ════════════════════════════════════════════════════════ */}
      <section style={{
        background: `linear-gradient(160deg, ${C.navy} 0%, #2a3580 60%, #1a4a7a 100%)`,
        padding: '80px 24px 100px',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Subtle background grid */}
        <div style={{
          position: 'absolute', inset: 0, opacity: .04,
          backgroundImage: 'linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
          pointerEvents: 'none',
        }} />

        <div style={{ maxWidth: 860, margin: '0 auto', textAlign: 'center', position: 'relative', zIndex: 1 }}>
          {/* Badge */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.2)',
            borderRadius: 20, padding: '5px 14px', marginBottom: 28,
          }}>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,.85)', fontFamily: F.body }}>
              Built for Swedish restaurant groups
            </span>
          </div>

          {/* Headline */}
          <h1 className="hero-headline" style={{
            fontFamily: F.display, fontWeight: 300, fontStyle: 'italic',
            fontSize: 'clamp(36px, 6vw, 60px)', color: 'white', lineHeight: 1.15,
            marginBottom: 20, letterSpacing: '-.01em',
          }}>
            Every number that matters,<br />
            <span style={{ fontStyle: 'normal', fontWeight: 400 }}>in one place.</span>
          </h1>

          {/* Subheadline */}
          <p style={{
            fontFamily: F.body, fontSize: 'clamp(16px, 2.5vw, 19px)',
            color: 'rgba(255,255,255,.7)', lineHeight: 1.7,
            maxWidth: 620, margin: '0 auto 36px',
          }}>
            Every system your business runs on, in one place — with AI that reads the numbers, explains what's changing, and helps you see what really matters.
          </p>

          {/* CTAs */}
          <div className="hero-btns" style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 48 }}>
            <Link href="/login?mode=signup&plan=founding" className="btn-white">
              Claim founding spot
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </Link>
            <a href="#pricing" className="btn-outline-white">
              See pricing
            </a>
          </div>

          {/* Stats */}
          <div className="stat-row" style={{
            display: 'flex', justifyContent: 'center', gap: 40,
            borderTop: '1px solid rgba(255,255,255,.12)', paddingTop: 36,
          }}>
            {[
              { value: '10 spots', label: 'Founding customers · 995 kr/mo' },
              { value: '< 5 min', label: 'To connect Personalkollen' },
              { value: '06:00', label: 'Daily auto-sync, every morning' },
            ].map(s => (
              <div key={s.value} style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: F.display, fontSize: 24, color: 'white', fontWeight: 400, marginBottom: 4 }}>
                  {s.value}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,.5)', fontFamily: F.body }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════
          FEATURES
      ════════════════════════════════════════════════════════ */}
      <section id="features" style={{ background: C.parchment, padding: '80px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>

          <div style={{ textAlign: 'center', marginBottom: 56 }}>
            <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: C.blue, marginBottom: 10, fontFamily: F.body }}>
              What you get
            </p>
            <h2 style={{ fontFamily: F.display, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 300, fontStyle: 'italic', color: C.navy, lineHeight: 1.25 }}>
              Everything a restaurant owner needs to know
            </h2>
          </div>

          <div className="features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>

            {[
              {
                icon: '👥',
                title: 'Staff costs, down to the hour',
                desc: 'See actual hours worked, OB supplements, lateness, and cost per department. Connected directly to Personalkollen — no manual export needed.',
                tags: ['Personalkollen', 'OB supplement', 'Lateness tracking'],
              },
              {
                icon: '📊',
                title: 'Revenue and covers, daily',
                desc: 'Track daily revenue, covers, food/drink split, and average spend per guest. Spot which days and services are your most profitable.',
                tags: ['Daily revenue', 'Covers', 'Food/drink split'],
              },
              {
                icon: '🤖',
                title: 'AI assistant on every page',
                desc: 'Ask questions in plain English: "Why is my margin down this month?" or "Which staff member had the most overtime?" — Claude answers based on your actual data.',
                tags: ['Claude AI', 'Contextual answers', 'Plain language'],
              },
              {
                icon: '🔔',
                title: 'Automated anomaly alerts',
                desc: 'Nightly analysis detects unusual spikes in costs or drops in revenue and emails you before the day starts. No need to stare at dashboards.',
                tags: ['Nightly scan', 'Email alerts', 'Threshold detection'],
              },
              {
                icon: '📈',
                title: 'P&L tracker and forecast',
                desc: 'Monthly profit & loss with manual entry for costs not yet in Fortnox. Revenue forecasts calibrated monthly to your actual patterns.',
                tags: ['Monthly P&L', 'Forecast', 'Budget targets'],
              },
              {
                icon: '📅',
                title: 'Weekly scheduling insights',
                desc: 'Group plan customers get a weekly AI-generated staff optimisation report — identifying overstaffed shifts and scheduling inefficiencies.',
                tags: ['Group plan', 'Weekly report', 'Optimisation'],
              },
            ].map(f => (
              <div key={f.title} className="feature-card">
                <div style={{ fontSize: 32, marginBottom: 16 }}>{f.icon}</div>
                <h3 style={{ fontFamily: F.display, fontSize: 20, fontWeight: 400, color: C.navy, marginBottom: 10, lineHeight: 1.3 }}>
                  {f.title}
                </h3>
                <p style={{ fontSize: 14, color: C.ink3, lineHeight: 1.7, marginBottom: 16 }}>
                  {f.desc}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {f.tags.map(t => (
                    <span key={t} style={{
                      fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6,
                      background: C.blueLt, color: C.blue, fontFamily: F.body,
                    }}>{t}</span>
                  ))}
                </div>
              </div>
            ))}

          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════
          INTEGRATIONS
      ════════════════════════════════════════════════════════ */}
      <section id="integrations" style={{ background: C.offWhite, padding: '80px 24px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>

          <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: C.blue, marginBottom: 10, fontFamily: F.body }}>
            Integrations
          </p>
          <h2 style={{ fontFamily: F.display, fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 300, fontStyle: 'italic', color: C.navy, marginBottom: 12, lineHeight: 1.3 }}>
            Your data, automatically.
          </h2>
          <p style={{ fontSize: 15, color: C.ink3, lineHeight: 1.7, marginBottom: 48, maxWidth: 560, margin: '0 auto 48px' }}>
            Connect your systems once. CommandCenter syncs every morning at 06:00 — no exports, no copy-paste, no spreadsheets.
          </p>

          <div className="integrations-row" style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 48 }}>

            <div className="integration-pill">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#E8F4FD', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🏢</div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>Personalkollen</div>
                <div style={{ fontSize: 12, color: C.ink4 }}>Staff shifts, hours, costs</div>
              </div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: C.greenLt, color: C.green }}>LIVE</span>
            </div>

            <div className="integration-pill">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#FFF5E5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📒</div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>Fortnox</div>
                <div style={{ fontSize: 12, color: C.ink4 }}>Invoices, supplier costs</div>
              </div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: C.amberLt, color: C.amber }}>SOON</span>
            </div>

            <div className="integration-pill">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: C.parchment, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🖥️</div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>Your POS</div>
                <div style={{ fontSize: 12, color: C.ink4 }}>Ancon, Swess, Trivec</div>
              </div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: C.parchment, color: C.ink4, border: `1px solid ${C.border}` }}>PLANNED</span>
            </div>

          </div>

          <p style={{ fontSize: 13, color: C.ink4 }}>
            More integrations in development. <a href="/login" style={{ color: C.blue }}>Request yours →</a>
          </p>

        </div>
      </section>

      {/* ════════════════════════════════════════════════════════
          PRICING
      ════════════════════════════════════════════════════════ */}
      <section id="pricing" style={{ background: C.parchment, padding: '80px 24px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>

          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: C.blue, marginBottom: 10, fontFamily: F.body }}>
              Pricing
            </p>
            <h2 style={{ fontFamily: F.display, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 300, fontStyle: 'italic', color: C.navy, marginBottom: 12, lineHeight: 1.25 }}>
              Pay from day one. Priced per restaurant.
            </h2>
            <p style={{ fontSize: 15, color: C.ink3, maxWidth: 620, margin: '0 auto' }}>
              Swedish operators don&rsquo;t buy toys. CommandCenter replaces a
              chunk of what a fractional CFO would charge you for — and it works
              while you sleep.
            </p>
          </div>

          {/* Founding-customer banner */}
          <div style={{
            background: C.navy,
            color: 'white',
            borderRadius: 16,
            padding: '28px 32px',
            marginBottom: 40,
            display: 'grid',
            gridTemplateColumns: '1fr auto',
            gap: 24,
            alignItems: 'center',
            boxShadow: '0 18px 48px -20px rgba(10,18,47,.35)',
          }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{
                  background: 'rgba(255,255,255,.12)', color: 'white',
                  fontSize: 11, fontWeight: 700, letterSpacing: '.08em',
                  textTransform: 'uppercase', padding: '4px 10px', borderRadius: 20,
                }}>Founding customer · 10 spots</span>
              </div>
              <h3 style={{ fontFamily: F.display, fontSize: 28, fontWeight: 400, fontStyle: 'italic', color: 'white', marginBottom: 6 }}>
                995 kr / month — locked for 24 months
              </h3>
              <p style={{ fontSize: 14, color: 'rgba(255,255,255,.72)', lineHeight: 1.5, maxWidth: 620 }}>
                Full Solo tier + most of Group for the first 10 restaurants to
                sign on. In exchange: monthly feedback, case-study partnership,
                and a direct line to the team. Converts to 1,495 kr/mo permanent
                discount after 24 months.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 180 }}>
              <Link href="/login?mode=signup&plan=founding" className="btn-white" style={{ justifyContent: 'center' }}>
                Claim founding spot
              </Link>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', textAlign: 'center' }}>
                No free trial. Paid from day one.
              </p>
            </div>
          </div>

          <div className="pricing-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, alignItems: 'start' }}>

            {/* Solo */}
            <div className="pricing-card">
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.ink4, marginBottom: 8 }}>Solo</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: F.display, fontSize: 38, fontWeight: 400, color: C.navy }}>1 995</span>
                <span style={{ fontSize: 14, color: C.ink3 }}>kr / mo</span>
              </div>
              <p style={{ fontSize: 13, color: C.ink4, marginBottom: 24 }}>Single restaurant</p>
              <div style={{ height: 1, background: C.border, marginBottom: 20 }} />
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                {[
                  '1 restaurant location',
                  'Fortnox PDF + Personalkollen',
                  'All core AI agents',
                  'Anomaly alerts + Monday Memo',
                  'P&L, budget, forecast, overheads',
                  '30 AI queries / day',
                  'Email support · 5 team seats',
                ].map(item => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.ink2 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/login?mode=signup&plan=solo" className="btn-outline-navy" style={{ justifyContent: 'center' }}>
                Get started
              </Link>
            </div>

            {/* Group — featured */}
            <div className="pricing-card featured" style={{ position: 'relative' }}>
              <div style={{
                position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                background: C.blue, color: 'white', fontSize: 11, fontWeight: 700,
                letterSpacing: '.08em', textTransform: 'uppercase', padding: '4px 14px',
                borderRadius: 20, whiteSpace: 'nowrap',
              }}>Most popular</div>
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)', marginBottom: 8 }}>Group</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: F.display, fontSize: 38, fontWeight: 400, color: 'white' }}>4 995</span>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,.55)' }}>kr / mo</span>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,.45)', marginBottom: 24 }}>2–5 restaurants</p>
              <div style={{ height: 1, background: 'rgba(255,255,255,.15)', marginBottom: 20 }} />
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                {[
                  'Up to 5 locations',
                  'Everything in Solo',
                  'Multi-location rollup + Departments',
                  'Weekly scheduling optimisation',
                  'Supplier price-creep alerts',
                  'Priority support · 24h SLA',
                  'Quarterly review call',
                  '100 AI queries / day · 25 seats',
                ].map(item => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'rgba(255,255,255,.85)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/login?mode=signup&plan=group" className="btn-white" style={{ justifyContent: 'center' }}>
                Get started
              </Link>
            </div>

            {/* Chain */}
            <div className="pricing-card">
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.ink4, marginBottom: 8 }}>Chain</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: F.display, fontSize: 38, fontWeight: 400, color: C.navy }}>9 995</span>
                <span style={{ fontSize: 14, color: C.ink3 }}>kr / mo+</span>
              </div>
              <p style={{ fontSize: 13, color: C.ink4, marginBottom: 24 }}>6+ restaurants</p>
              <div style={{ height: 1, background: C.border, marginBottom: 20 }} />
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                {[
                  'Unlimited restaurants',
                  'Everything in Group',
                  'Dedicated onboarding',
                  'Custom Fortnox OAuth setup',
                  'API access (when available)',
                  'Unlimited AI usage',
                  'Unlimited team seats',
                ].map(item => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.ink2 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/login?mode=signup&plan=chain" className="btn-outline-navy" style={{ justifyContent: 'center' }}>
                Contact us
              </Link>
            </div>

          </div>

          {/* Annual note */}
          <p style={{ textAlign: 'center', fontSize: 13, color: C.ink4, marginTop: 24 }}>
            Annual billing saves ~17% (2 months free). Invoicing available — standard for Swedish B2B.
          </p>

        </div>
      </section>

      {/* ════════════════════════════════════════════════════════
          FINAL CTA
      ════════════════════════════════════════════════════════ */}
      <section style={{
        background: C.navy,
        padding: '80px 24px',
        textAlign: 'center',
      }}>
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <h2 style={{
            fontFamily: F.display, fontSize: 'clamp(28px, 4vw, 42px)',
            fontWeight: 300, fontStyle: 'italic', color: 'white',
            lineHeight: 1.25, marginBottom: 16,
          }}>
            Ready to see what&apos;s really going on in your restaurants?
          </h2>
          <p style={{ fontSize: 16, color: 'rgba(255,255,255,.6)', marginBottom: 36, lineHeight: 1.7 }}>
            10 founding spots at 995 kr/mo, locked for 24 months. Setup takes under 5 minutes. Cancel any time.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link href="/login?mode=signup&plan=founding" className="btn-white">
              Claim founding spot
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </Link>
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════════════════════
          FOOTER
      ════════════════════════════════════════════════════════ */}
      <footer style={{ background: C.ink, padding: '48px 24px 32px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>

          <div className="footer-grid" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 48, marginBottom: 40 }}>

            {/* Brand */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(255,255,255,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                  </svg>
                </div>
                <span style={{ fontFamily: F.display, fontSize: 15, color: 'white', fontWeight: 400 }}>CommandCenter</span>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,.4)', lineHeight: 1.7, maxWidth: 240 }}>
                AI-powered business intelligence for Swedish restaurant groups. Built in Sweden.
              </p>
            </div>

            {/* Product */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.35)', marginBottom: 14 }}>Product</p>
              {['Features', 'Integrations', 'Pricing', 'Changelog'].map(l => (
                <div key={l} style={{ marginBottom: 10 }}>
                  <a href="#" className="footer-link">{l}</a>
                </div>
              ))}
            </div>

            {/* Company */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.35)', marginBottom: 14 }}>Company</p>
              {[
                { label: 'About', href: '#' },
                { label: 'Contact', href: '#' },
              ].map(l => (
                <div key={l.label} style={{ marginBottom: 10 }}>
                  <a href={l.href} className="footer-link">{l.label}</a>
                </div>
              ))}
            </div>

            {/* Legal */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.35)', marginBottom: 14 }}>Legal</p>
              {[
                { label: 'Terms of service', href: '/terms' },
                { label: 'Privacy policy', href: '/privacy' },
                { label: 'Sub-processors', href: '/privacy#5' },
                { label: 'Security',         href: '/security' },
              ].map(l => (
                <div key={l.label} style={{ marginBottom: 10 }}>
                  <a href={l.href} className="footer-link">{l.label}</a>
                </div>
              ))}
            </div>

          </div>

          {/* Imprint — required by Lag (2002:562) §8 for Swedish commercial sites */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 20, paddingBottom: 16, fontSize: 12, color: 'rgba(255,255,255,.35)', lineHeight: 1.7 }}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.4)', marginBottom: 8 }}>Provider</p>
            <p style={{ margin: 0 }}>
              CommandCenter is operated by <strong style={{ color: 'rgba(255,255,255,.55)' }}>Dransfield Invest AB</strong>.
              {' '}Registered in Sweden.
              {' '}Org. nr: <span style={{ fontFamily: 'ui-monospace, monospace' }}>pending registration</span>.
              {' '}Momsnr (VAT): <span style={{ fontFamily: 'ui-monospace, monospace' }}>pending registration</span>.
              {' '}Registered address: <span style={{ fontStyle: 'italic' as const }}>pending</span>.
              {' '}Contact: <a href="mailto:paul@laweka.com" style={{ color: 'rgba(255,255,255,.55)', textDecoration: 'none' }}>paul@laweka.com</a>
              {' '}· Security / vulnerability reports: <a href="mailto:paul@laweka.com" style={{ color: 'rgba(255,255,255,.55)', textDecoration: 'none' }}>paul@laweka.com</a>.
              {' '}For data-subject requests (GDPR Art. 15–22) use the Data &amp; Privacy section inside your account.
              {' '}Supervisory authority: <a href="https://www.imy.se" target="_blank" rel="noreferrer" style={{ color: 'rgba(255,255,255,.55)', textDecoration: 'none' }}>Integritetsskyddsmyndigheten (IMY)</a>.
              {' '}CommandCenter is a B2B service — not intended for consumers.
            </p>
          </div>

          {/* Bottom bar */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,.3)' }}>
              © {new Date().getFullYear()} Dransfield Invest AB. CommandCenter™ is a product of Dransfield Invest AB.
            </p>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,.3)' }}>
              GDPR compliant · Data stored in EU (Frankfurt) · Swedish law
            </p>
          </div>

        </div>
      </footer>
    </>
  )
}

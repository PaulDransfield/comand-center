// app/page.tsx — Public landing page
// Shown to all visitors at comandcenter.se
// Logged-in users see the nav link to dashboard; logged-out users see login/signup CTAs
// i18n PR 5: server-rendered translations via getTranslations + a small
// LanguageSelector client island in the nav so visitors can switch language
// before signup.

import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { LanguageSelector } from '@/components/LanguageSelector'

export async function generateMetadata() {
  const t = await getTranslations('landing.meta')
  return {
    title:       t('title'),
    description: t('description'),
  }
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

export default async function LandingPage() {
  const t = await getTranslations('landing')
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
            <a href="#features" className="nav-link">{t('nav.features')}</a>
            <a href="#integrations" className="nav-link">{t('nav.integrations')}</a>
            <a href="#pricing" className="nav-link">{t('nav.pricing')}</a>
          </div>

          {/* CTAs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Language selector — inline pills, dark tone for the navy navbar.
                Sits to the left of the auth CTAs so visitors can switch
                language before signing up. */}
            <div className="nav-cta-login">
              <LanguageSelector variant="inline" onTone="dark" />
            </div>
            <Link href="/login" className="btn-outline-white nav-cta-login" style={{ padding: '8px 18px', fontSize: 13 }}>
              {t('nav.logIn')}
            </Link>
            <Link href="/login?mode=signup&plan=founding" className="btn-white nav-cta-trial" style={{ padding: '8px 18px', fontSize: 13 }}>
              {t('nav.getStarted')}
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
              {t('hero.badge')}
            </span>
          </div>

          {/* Headline */}
          <h1 className="hero-headline" style={{
            fontFamily: F.display, fontWeight: 300, fontStyle: 'italic',
            fontSize: 'clamp(36px, 6vw, 60px)', color: 'white', lineHeight: 1.15,
            marginBottom: 20, letterSpacing: '-.01em',
          }}>
            {t('hero.headlineA')}<br />
            <span style={{ fontStyle: 'normal', fontWeight: 400 }}>{t('hero.headlineB')}</span>
          </h1>

          {/* Subheadline */}
          <p style={{
            fontFamily: F.body, fontSize: 'clamp(16px, 2.5vw, 19px)',
            color: 'rgba(255,255,255,.7)', lineHeight: 1.7,
            maxWidth: 620, margin: '0 auto 36px',
          }}>
            {t('hero.subhead')}
          </p>

          {/* CTAs */}
          <div className="hero-btns" style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 48 }}>
            <Link href="/login?mode=signup&plan=founding" className="btn-white">
              {t('hero.ctaPrimary')}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </Link>
            <a href="#pricing" className="btn-outline-white">
              {t('hero.ctaPricing')}
            </a>
          </div>

          {/* Stats */}
          <div className="stat-row" style={{
            display: 'flex', justifyContent: 'center', gap: 40,
            borderTop: '1px solid rgba(255,255,255,.12)', paddingTop: 36,
          }}>
            {[
              { value: t('hero.stat1'), label: t('hero.stat1Label') },
              { value: t('hero.stat2'), label: t('hero.stat2Label') },
              { value: t('hero.stat3'), label: t('hero.stat3Label') },
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
              {t('features.eyebrow')}
            </p>
            <h2 style={{ fontFamily: F.display, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 300, fontStyle: 'italic', color: C.navy, lineHeight: 1.25 }}>
              {t('features.headline')}
            </h2>
          </div>

          <div className="features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>

            {[
              { icon: '👥', key: 'card1' },
              { icon: '📊', key: 'card2' },
              { icon: '🤖', key: 'card3' },
              { icon: '🔔', key: 'card4' },
              { icon: '📈', key: 'card5' },
              { icon: '📅', key: 'card6' },
            ].map(c => ({
              icon:  c.icon,
              title: t(`features.${c.key}.title`),
              desc:  t(`features.${c.key}.desc`),
              tags:  [
                t(`features.${c.key}.tag1`),
                t(`features.${c.key}.tag2`),
                t(`features.${c.key}.tag3`),
              ],
            })).map(f => (
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
            {t('integrations.eyebrow')}
          </p>
          <h2 style={{ fontFamily: F.display, fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 300, fontStyle: 'italic', color: C.navy, marginBottom: 12, lineHeight: 1.3 }}>
            {t('integrations.headline')}
          </h2>
          <p style={{ fontSize: 15, color: C.ink3, lineHeight: 1.7, marginBottom: 48, maxWidth: 560, margin: '0 auto 48px' }}>
            {t('integrations.subhead')}
          </p>

          <div className="integrations-row" style={{ display: 'flex', justifyContent: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 48 }}>

            <div className="integration-pill">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#E8F4FD', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🏢</div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>{t('integrations.pk')}</div>
                <div style={{ fontSize: 12, color: C.ink4 }}>{t('integrations.pkDesc')}</div>
              </div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: C.greenLt, color: C.green }}>{t('integrations.live')}</span>
            </div>

            <div className="integration-pill">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: '#FFF5E5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📒</div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>{t('integrations.fortnox')}</div>
                <div style={{ fontSize: 12, color: C.ink4 }}>{t('integrations.fortnoxDesc')}</div>
              </div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: C.amberLt, color: C.amber }}>{t('integrations.soon')}</span>
            </div>

            <div className="integration-pill">
              <div style={{ width: 36, height: 36, borderRadius: 8, background: C.parchment, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🖥️</div>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.ink }}>{t('integrations.pos')}</div>
                <div style={{ fontSize: 12, color: C.ink4 }}>{t('integrations.posDesc')}</div>
              </div>
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6, background: C.parchment, color: C.ink4, border: `1px solid ${C.border}` }}>{t('integrations.planned')}</span>
            </div>

          </div>

          <p style={{ fontSize: 13, color: C.ink4 }}>
            {t('integrations.request')} <a href="/login" style={{ color: C.blue }}>{t('integrations.requestLink')}</a>
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
              {t('pricing.eyebrow')}
            </p>
            <h2 style={{ fontFamily: F.display, fontSize: 'clamp(28px, 4vw, 40px)', fontWeight: 300, fontStyle: 'italic', color: C.navy, marginBottom: 12, lineHeight: 1.25 }}>
              {t('pricing.headline')}
            </h2>
            <p style={{ fontSize: 15, color: C.ink3, maxWidth: 620, margin: '0 auto' }}>
              {t('pricing.subhead')}
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
                }}>{t('pricing.founding.badge')}</span>
              </div>
              <h3 style={{ fontFamily: F.display, fontSize: 28, fontWeight: 400, fontStyle: 'italic', color: 'white', marginBottom: 6 }}>
                {t('pricing.founding.title')}
              </h3>
              <p style={{ fontSize: 14, color: 'rgba(255,255,255,.72)', lineHeight: 1.5, maxWidth: 620 }}>
                {t('pricing.founding.body')}
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 180 }}>
              <Link href="/login?mode=signup&plan=founding" className="btn-white" style={{ justifyContent: 'center' }}>
                {t('pricing.founding.cta')}
              </Link>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,.5)', textAlign: 'center' }}>
                {t('pricing.founding.footnote')}
              </p>
            </div>
          </div>

          <div className="pricing-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, alignItems: 'start' }}>

            {/* Solo */}
            <div className="pricing-card">
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.ink4, marginBottom: 8 }}>{t('pricing.solo.name')}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: F.display, fontSize: 38, fontWeight: 400, color: C.navy }}>{t('pricing.solo.price')}</span>
                <span style={{ fontSize: 14, color: C.ink3 }}>{t('pricing.solo.perMonth')}</span>
              </div>
              <p style={{ fontSize: 13, color: C.ink4, marginBottom: 24 }}>{t('pricing.solo.scope')}</p>
              <div style={{ height: 1, background: C.border, marginBottom: 20 }} />
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                {[
                  t('pricing.solo.feat1'),
                  t('pricing.solo.feat2'),
                  t('pricing.solo.feat3'),
                  t('pricing.solo.feat4'),
                  t('pricing.solo.feat5'),
                  t('pricing.solo.feat6'),
                  t('pricing.solo.feat7'),
                ].map(item => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.ink2 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/login?mode=signup&plan=solo" className="btn-outline-navy" style={{ justifyContent: 'center' }}>
                {t('pricing.solo.cta')}
              </Link>
            </div>

            {/* Group — featured */}
            <div className="pricing-card featured" style={{ position: 'relative' }}>
              <div style={{
                position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)',
                background: C.blue, color: 'white', fontSize: 11, fontWeight: 700,
                letterSpacing: '.08em', textTransform: 'uppercase', padding: '4px 14px',
                borderRadius: 20, whiteSpace: 'nowrap',
              }}>{t('pricing.group.popular')}</div>
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.55)', marginBottom: 8 }}>{t('pricing.group.name')}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: F.display, fontSize: 38, fontWeight: 400, color: 'white' }}>{t('pricing.group.price')}</span>
                <span style={{ fontSize: 14, color: 'rgba(255,255,255,.55)' }}>{t('pricing.group.perMonth')}</span>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,.45)', marginBottom: 24 }}>{t('pricing.group.scope')}</p>
              <div style={{ height: 1, background: 'rgba(255,255,255,.15)', marginBottom: 20 }} />
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                {[
                  t('pricing.group.feat1'),
                  t('pricing.group.feat2'),
                  t('pricing.group.feat3'),
                  t('pricing.group.feat4'),
                  t('pricing.group.feat5'),
                  t('pricing.group.feat6'),
                  t('pricing.group.feat7'),
                  t('pricing.group.feat8'),
                ].map(item => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: 'rgba(255,255,255,.85)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.7)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/login?mode=signup&plan=group" className="btn-white" style={{ justifyContent: 'center' }}>
                {t('pricing.group.cta')}
              </Link>
            </div>

            {/* Chain */}
            <div className="pricing-card">
              <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: C.ink4, marginBottom: 8 }}>{t('pricing.chain.name')}</p>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: F.display, fontSize: 38, fontWeight: 400, color: C.navy }}>{t('pricing.chain.price')}</span>
                <span style={{ fontSize: 14, color: C.ink3 }}>{t('pricing.chain.perMonth')}</span>
              </div>
              <p style={{ fontSize: 13, color: C.ink4, marginBottom: 24 }}>{t('pricing.chain.scope')}</p>
              <div style={{ height: 1, background: C.border, marginBottom: 20 }} />
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
                {[
                  t('pricing.chain.feat1'),
                  t('pricing.chain.feat2'),
                  t('pricing.chain.feat3'),
                  t('pricing.chain.feat4'),
                  t('pricing.chain.feat5'),
                  t('pricing.chain.feat6'),
                  t('pricing.chain.feat7'),
                ].map(item => (
                  <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, color: C.ink2 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.green} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/login?mode=signup&plan=chain" className="btn-outline-navy" style={{ justifyContent: 'center' }}>
                {t('pricing.chain.cta')}
              </Link>
            </div>

          </div>

          {/* Annual note */}
          <p style={{ textAlign: 'center', fontSize: 13, color: C.ink4, marginTop: 24 }}>
            {t('pricing.annualNote')}
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
            {t('finalCta.headline')}
          </h2>
          <p style={{ fontSize: 16, color: 'rgba(255,255,255,.6)', marginBottom: 36, lineHeight: 1.7 }}>
            {t('finalCta.subhead')}
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link href="/login?mode=signup&plan=founding" className="btn-white">
              {t('finalCta.cta')}
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
                {t('footer.tagline')}
              </p>
            </div>

            {/* Product */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.35)', marginBottom: 14 }}>{t('footer.product')}</p>
              {[
                { label: t('footer.links.features'),     href: '#features' },
                { label: t('footer.links.integrations'), href: '#integrations' },
                { label: t('footer.links.pricing'),      href: '#pricing' },
                { label: t('footer.links.changelog'),    href: '#' },
              ].map(l => (
                <div key={l.label} style={{ marginBottom: 10 }}>
                  <a href={l.href} className="footer-link">{l.label}</a>
                </div>
              ))}
            </div>

            {/* Company */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.35)', marginBottom: 14 }}>{t('footer.company')}</p>
              {[
                { label: t('footer.links.about'),   href: '#' },
                { label: t('footer.links.contact'), href: '#' },
              ].map(l => (
                <div key={l.label} style={{ marginBottom: 10 }}>
                  <a href={l.href} className="footer-link">{l.label}</a>
                </div>
              ))}
            </div>

            {/* Legal */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.35)', marginBottom: 14 }}>{t('footer.legal')}</p>
              {[
                { label: t('footer.links.terms'),         href: '/terms' },
                { label: t('footer.links.privacy'),       href: '/privacy' },
                { label: t('footer.links.subprocessors'), href: '/privacy#5' },
                { label: t('footer.links.security'),      href: '/security' },
              ].map(l => (
                <div key={l.label} style={{ marginBottom: 10 }}>
                  <a href={l.href} className="footer-link">{l.label}</a>
                </div>
              ))}
            </div>

          </div>

          {/* Imprint — required by Lag (2002:562) §8 for Swedish commercial sites.
              Body comes through translations; emails / IMY link stay
              hardcoded so they're never accidentally translated and the
              click-targets are stable across locales. */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 20, paddingBottom: 16, fontSize: 12, color: 'rgba(255,255,255,.35)', lineHeight: 1.7 }}>
            <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,.4)', marginBottom: 8 }}>{t('footer.provider')}</p>
            <p style={{ margin: 0 }}>
              {t('footer.imprintBody')}
            </p>
          </div>

          {/* Bottom bar */}
          <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,.3)' }}>
              {t('footer.copyright', { year: new Date().getFullYear() })}
            </p>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,.3)' }}>
              {t('footer.compliance')}
            </p>
          </div>

        </div>
      </footer>
    </>
  )
}

'use client'
// components/dashboard/DashboardHeader.tsx
//
// Page-header strip for the redesigned /dashboard. Replaces the
// full-width yellow alert banner with a small pulsing pill that links
// to /alerts. Title block on the left, anomaly pill in the middle (only
// when high/critical alerts exist), Export action on the right.
//
// Pulls from the SAME alert filter the legacy banner used: severity in
// {high, critical}, top row only. The detector's deterministic title
// format `OB supplement spike +X% — {bizName}` is rendered byte-for-byte;
// no rewrite happens here.

import { UX } from '@/lib/constants/tokens'
import { useTranslations } from 'next-intl'

export interface DashboardAlert {
  id:          string
  title:       string
  description: string | null
  severity:    'low' | 'medium' | 'high' | 'critical'
}

interface Props {
  breadcrumb:    string
  pageTitle:     string
  alerts:        DashboardAlert[]
  onExport?:     () => void
}

export default function DashboardHeader({ breadcrumb, pageTitle, alerts, onExport }: Props) {
  const t = useTranslations('dashboard.header')
  // Same filter the legacy banner used (`page.tsx:594`) — severity high/critical,
  // first row only. Pill hides entirely when nothing matches.
  const topAlert = alerts.find(a => a.severity === 'high' || a.severity === 'critical') ?? null

  return (
    <div className="cc-dash-header" style={wrapStyle}>
      <div style={leftBlock}>
        <div style={crumbStyle}>{breadcrumb}</div>
        <h1 style={titleStyle}>{pageTitle}</h1>
      </div>

      {topAlert && (
        <a href="/alerts" className="cc-dash-header-pill" style={pillLinkStyle} aria-label={t('anomalyAria', { title: topAlert.title })}>
          <span style={pillDotStyle} />
          <span style={pillTextStyle}>{topAlert.title}</span>
          <span style={pillArrowStyle} aria-hidden>→</span>
        </a>
      )}

      <div className="cc-dash-header-right" style={rightBlock}>
        {onExport && (
          <button onClick={onExport} style={exportBtnStyle} type="button">
            {t('export')}
          </button>
        )}
      </div>
      {/* Pulse keyframes — scoped via inline style tag so we don't depend on
          a global stylesheet reference. */}
      <style>{`
        @keyframes cc-dash-pill-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5); }
          70%  { box-shadow: 0 0 0 7px rgba(220, 38, 38, 0); }
          100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); }
        }
        @media (max-width: 880px) {
          .cc-dash-header { flex-direction: column; align-items: flex-start; gap: 12px; }
          .cc-dash-header .cc-dash-header-pill { max-width: 100%; }
          .cc-dash-header .cc-dash-header-right { width: 100%; justify-content: flex-end; }
        }
      `}</style>
    </div>
  )
}

const wrapStyle: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'center',
  marginBottom:   18,
  gap:            18,
  flexWrap:       'wrap',
}

const leftBlock: React.CSSProperties = {
  display:       'flex',
  flexDirection: 'column' as const,
  gap:           4,
  minWidth:      0,
}

const crumbStyle: React.CSSProperties = {
  fontSize: 12,
  color:    UX.ink3,
}

const titleStyle: React.CSSProperties = {
  fontSize:      22,
  fontWeight:    700,
  letterSpacing: '-0.015em',
  lineHeight:    1.2,
  color:         UX.ink1,
  margin:        0,
}

// Anomaly pill — uses UX.redInk + UX.redSoft (token palette). Animated
// pulse via an inline keyframes block rendered inside the component.
const pillLinkStyle: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  gap:            8,
  background:     UX.redSoft,
  border:         `1px solid ${UX.redBorder}`,
  color:          UX.redInk,
  fontSize:       12,
  fontWeight:     600,
  padding:        '5px 12px 5px 8px',
  borderRadius:   999,
  textDecoration: 'none',
  cursor:         'pointer',
  transition:     'background 0.15s',
  maxWidth:       '40%',
  overflow:       'hidden',
  whiteSpace:     'nowrap',
  textOverflow:   'ellipsis',
}

const pillDotStyle: React.CSSProperties = {
  width:        8,
  height:       8,
  background:   UX.redInk,
  borderRadius: '50%',
  flexShrink:   0,
  animation:    'cc-dash-pill-pulse 2.4s infinite',
}

const pillTextStyle: React.CSSProperties = {
  overflow:     'hidden',
  textOverflow: 'ellipsis',
  whiteSpace:   'nowrap',
}

const pillArrowStyle: React.CSSProperties = {
  fontWeight:  400,
  opacity:     0.7,
  marginLeft:  2,
}

const rightBlock: React.CSSProperties = {
  display:    'flex',
  gap:        10,
  alignItems: 'center',
}

const exportBtnStyle: React.CSSProperties = {
  background:   'white',
  color:        UX.ink2,
  border:       `1px solid ${UX.border}`,
  padding:      '8px 14px',
  borderRadius: 999,
  fontSize:     13,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}

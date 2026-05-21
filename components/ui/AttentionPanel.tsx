// components/ui/AttentionPanel.tsx
// Universal page footer — replaces "Best GP%" / "Needs Attention" / "Insights"
// cards scattered across pages. Up to 4 items; overflow goes behind a link.
// Spec: DESIGN.md § AttentionPanel.

'use client'

import { useTranslations } from 'next-intl'
import { UXP } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export type AttentionTone = 'good' | 'warning' | 'bad'

export interface AttentionItem {
  tone:    AttentionTone
  entity:  string    // "Carne", "Rosali Deli", "AI"
  message: string    // one sentence, ≤ 120 chars
}

export interface AttentionPanelProps {
  title?:    string
  items:     AttentionItem[]
  maxItems?: number
  moreHref?: string       // route for "+ N more →" link
  rightSlot?: ReactNode   // optional right-aligned content in the header
}

const DOT_COLOUR: Record<AttentionTone, string> = {
  good:    UXP.greenDeep,
  warning: UXP.coral,
  bad:     UXP.roseText,
}

export default function AttentionPanel({
  title,
  items,
  maxItems = 4,
  moreHref,
  rightSlot,
}: AttentionPanelProps) {
  const t = useTranslations('common.attention')
  const shown  = items.slice(0, maxItems)
  const hidden = Math.max(0, items.length - shown.length)
  const headingTitle = title ?? t('defaultTitle')

  return (
    <div
      style={{
        background:   UXP.cardBg,
        border:       `0.5px solid ${UXP.border}`,
        borderRadius: UXP.r_lg,
        padding:      '12px 14px',
      }}
    >
      <div style={{
        display:         'flex',
        justifyContent:  'space-between',
        alignItems:      'baseline',
        marginBottom:    shown.length ? 8 : 0,
      }}>
        <div style={{
          fontSize:    13,
          fontWeight:  500,
          color:       UXP.ink1,
        }}>
          {headingTitle}
        </div>
        {rightSlot}
      </div>

      {shown.length === 0 ? (
        <div style={{ fontSize: 12, color: UXP.ink4, padding: '8px 0' }}>
          {t('nothingFlagged')}
        </div>
      ) : (
        <>
          {shown.map((it, i) => (
            <div
              key={`${it.entity}-${i}`}
              style={{
                display:      'flex',
                alignItems:   'flex-start',
                gap:          8,
                padding:      '7px 0',
                borderBottom: i === shown.length - 1 ? 'none' : `0.5px solid ${UXP.borderSoft}`,
              }}
            >
              <span
                aria-hidden
                style={{
                  width:        5,
                  height:       5,
                  borderRadius: '50%',
                  background:   DOT_COLOUR[it.tone],
                  flexShrink:   0,
                  marginTop:    7,
                }}
              />
              <div style={{ minWidth: 0, fontSize: 12, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 500, color: UXP.ink1 }}>{it.entity}</span>
                <span style={{ color: UXP.ink2 }}> — {it.message}</span>
              </div>
            </div>
          ))}

          {hidden > 0 && (
            moreHref ? (
              <a
                href={moreHref}
                style={{
                  display:        'inline-block',
                  marginTop:      6,
                  fontSize:       11,
                  color:          UXP.lavDeep,
                  textDecoration: 'none',
                  fontWeight:     500,
                }}
              >
                {t('moreLink', { count: hidden })}
              </a>
            ) : (
              <div style={{ marginTop: 6, fontSize: 11, color: UXP.ink3 }}>
                {t('moreText', { count: hidden })}
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

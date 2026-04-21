// components/ui/AttentionPanel.tsx
// Universal page footer — replaces "Best GP%" / "Needs Attention" / "Insights"
// cards scattered across pages. Up to 4 items; overflow goes behind a link.
// Spec: DESIGN.md § AttentionPanel.

'use client'

import { UX } from '@/lib/constants/tokens'
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
  good:    UX.greenInk,
  warning: UX.amberInk,
  bad:     UX.redInk,
}

export default function AttentionPanel({
  title = 'Needs your attention',
  items,
  maxItems = 4,
  moreHref,
  rightSlot,
}: AttentionPanelProps) {
  const shown  = items.slice(0, maxItems)
  const hidden = Math.max(0, items.length - shown.length)

  return (
    <div
      style={{
        background:   UX.cardBg,
        border:       `0.5px solid ${UX.border}`,
        borderRadius: UX.r_lg,
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
          fontSize:    UX.fsSection,
          fontWeight:  UX.fwMedium,
          color:       UX.ink1,
        }}>
          {title}
        </div>
        {rightSlot}
      </div>

      {shown.length === 0 ? (
        <div style={{ fontSize: UX.fsBody, color: UX.ink4, padding: '8px 0' }}>
          Nothing flagged right now.
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
                borderBottom: i === shown.length - 1 ? 'none' : `0.5px solid ${UX.borderSoft}`,
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
              <div style={{ minWidth: 0, fontSize: UX.fsBody, lineHeight: 1.5 }}>
                <span style={{ fontWeight: UX.fwMedium, color: UX.ink1 }}>{it.entity}</span>
                <span style={{ color: UX.ink2 }}> — {it.message}</span>
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
                  fontSize:       UX.fsLabel,
                  color:          UX.indigo,
                  textDecoration: 'none',
                  fontWeight:     UX.fwMedium,
                }}
              >
                + {hidden} more →
              </a>
            ) : (
              <div style={{ marginTop: 6, fontSize: UX.fsLabel, color: UX.ink3 }}>
                + {hidden} more
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

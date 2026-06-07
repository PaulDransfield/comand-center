// components/ui/EmptyState.tsx
//
// Shared empty-state surface. Used wherever a list / grid finishes
// loading and the result is genuinely empty (not loading, not erroring,
// just nothing to show yet). The card replaces the previous one-line
// "no items" grey text so new customers see a designed "what to do
// next" prompt instead of a surface that looks broken.
//
// Three slots:
//   - badge:       small uppercase chip at the top (tier label)
//   - title:       single-sentence headline
//   - description: 1-2 sentence paragraph
//   - action:      primary CTA (label + onClick OR href)
//   - secondary:   optional secondary CTA (e.g. "Learn more" link)
//
// All slots optional except title — minimum viable empty state is just
// a title + description so any page can drop it in cheaply.

import { UXP } from '@/lib/constants/tokens'

export type EmptyStateTone = 'neutral' | 'success' | 'attention'

interface ActionDescriptor {
  label:   string
  onClick?: () => void
  href?:    string
}

interface Props {
  title:        string
  description?: string
  badge?:       string                                                      // e.g. "No items yet"
  tone?:        EmptyStateTone                                              // colours the badge chip
  action?:      ActionDescriptor                                            // primary CTA
  secondary?:   ActionDescriptor                                            // secondary CTA
  style?:       React.CSSProperties                                         // override container style
}

const TONES: Record<EmptyStateTone, { bg: string; border: string; ink: string }> = {
  neutral:   { bg: UXP.subtleBg,   border: UXP.border,             ink: UXP.ink3   },
  success:   { bg: UXP.greenFill,  border: `${UXP.green}55`,       ink: UXP.green  },
  attention: { bg: '#fef3e0',      border: `${UXP.coral}55`,       ink: UXP.coral  },
}

function ActionButton({ action, primary }: { action: ActionDescriptor; primary: boolean }) {
  const base: React.CSSProperties = {
    padding: '9px 16px',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: primary ? 600 : 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    border: primary ? 'none' : `0.5px solid ${UXP.border}`,
    background: primary ? UXP.lavDeep : UXP.cardBg,
    color: primary ? '#fff' : UXP.ink1,
    textDecoration: 'none' as const,
    display: 'inline-flex',
    alignItems: 'center',
  }
  if (action.href) {
    return (
      <a href={action.href} style={base}>
        {action.label}
      </a>
    )
  }
  return (
    <button onClick={action.onClick} style={base}>
      {action.label}
    </button>
  )
}

export function EmptyState({
  title, description, badge, tone = 'neutral', action, secondary, style,
}: Props) {
  const t = TONES[tone]
  return (
    <div style={{
      background: UXP.cardBg,
      border: `0.5px solid ${UXP.border}`,
      borderRadius: 10,
      padding: '40px 28px',
      textAlign: 'center' as const,
      maxWidth: 520,
      margin: '0 auto',
      ...style,
    }}>
      {badge && (
        <div style={{
          display: 'inline-block',
          padding: '3px 8px',
          background: t.bg,
          border: `0.5px solid ${t.border}`,
          borderRadius: 5,
          fontSize: 10,
          color: t.ink,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase' as const,
          marginBottom: 12,
        }}>
          {badge}
        </div>
      )}
      <h3 style={{
        margin: '0 0 8px',
        fontSize: 16,
        fontWeight: 600,
        color: UXP.ink1,
        lineHeight: 1.4,
      }}>
        {title}
      </h3>
      {description && (
        <p style={{
          margin: '0 0 20px',
          fontSize: 13,
          color: UXP.ink2,
          lineHeight: 1.55,
          maxWidth: 380,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}>
          {description}
        </p>
      )}
      {(action || secondary) && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' as const }}>
          {action     && <ActionButton action={action}    primary={true}  />}
          {secondary  && <ActionButton action={secondary} primary={false} />}
        </div>
      )}
    </div>
  )
}

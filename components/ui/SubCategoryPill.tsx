// components/ui/SubCategoryPill.tsx
//
// Renders a product's sub_category as a small lavender pill. Tone is
// derived from classification_confidence:
//   - >= 0.85  → solid lavender (high-confidence, supplier or GTIN)
//   - 0.7 - 0.85 → pale lavender (mid-confidence, web/cross-customer)
//   - < 0.7  → coral (low-confidence — owner should verify)
//   - null   → "uncategorised" outline pill (needs classification)

import { UXP } from '@/lib/constants/tokens'
import { subCategoryLabel } from '@/lib/inventory/taxonomy'

interface Props {
  subCategory: string | null
  confidence?: number | null
  source?:     string | null     // shown in title tooltip when present
  size?:       'sm' | 'xs'       // sm = 11px (default), xs = 9px for mobile cards
}

export function SubCategoryPill({ subCategory, confidence, source, size = 'sm' }: Props) {
  const fontSize = size === 'xs' ? 9 : 11
  const padding  = size === 'xs' ? '1px 6px' : '2px 8px'

  if (!subCategory) {
    return (
      <span
        title="Not yet classified. Click 'Classify catalogue' to assign a sub-category."
        style={{
          fontSize, padding, fontWeight: 600, letterSpacing: '0.03em',
          background: 'transparent',
          color:      UXP.ink4,
          border:     `0.5px dashed ${UXP.border}`,
          borderRadius: 4,
          textTransform: 'uppercase' as const,
          whiteSpace: 'nowrap' as const,
        }}
      >
        Uncategorised
      </span>
    )
  }

  const conf = confidence ?? 0
  const isHigh = conf >= 0.85
  const isMid  = conf >= 0.7 && conf < 0.85
  const isLow  = conf < 0.7

  const palette = isHigh
    ? { bg: UXP.lavDeep,    fg: '#fff'        }
    : isMid
    ? { bg: UXP.lavFill,    fg: UXP.lavText   }
    : { bg: '#fef3e0',      fg: UXP.coral     }

  const titleParts = [`Sub-category: ${subCategoryLabel(subCategory)}`]
  if (source)            titleParts.push(`Source: ${source}`)
  if (confidence != null) titleParts.push(`Confidence: ${(conf * 100).toFixed(0)}%`)
  if (isLow)              titleParts.push('Low confidence — review and edit if wrong.')

  return (
    <span
      title={titleParts.join('\n')}
      style={{
        fontSize, padding, fontWeight: 600, letterSpacing: '0.02em',
        background: palette.bg,
        color:      palette.fg,
        borderRadius: 4,
        whiteSpace: 'nowrap' as const,
      }}
    >
      {subCategoryLabel(subCategory)}
    </span>
  )
}

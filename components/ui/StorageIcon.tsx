// components/ui/StorageIcon.tsx
//
// Small icon indicating product storage zone — frozen, refrigerated,
// or ambient. Inline next to product names so a chef pulling stock
// knows which zone to walk to before clicking.
//
// Pure SVG, no font dependency. Tone-coded:
//   frozen        → cold blue
//   refrigerated  → cool mint
//   ambient       → warm sand
//
// `size` defaults to 14 (inline with body text). Mobile cards use 12.

import { UXP } from '@/lib/constants/tokens'

type Storage = 'frozen' | 'refrigerated' | 'ambient'

interface Props {
  storage:  string | null
  size?:    number
}

export function StorageIcon({ storage, size = 14 }: Props) {
  if (storage !== 'frozen' && storage !== 'refrigerated' && storage !== 'ambient') return null
  const s = storage as Storage

  const COLOR: Record<Storage, string> = {
    frozen:       '#5b8fc4',     // cold blue
    refrigerated: '#5f9e7e',     // mint
    ambient:      UXP.costAmber, // warm sand
  }
  const TITLE: Record<Storage, string> = {
    frozen:       'Frozen — store in freezer',
    refrigerated: 'Refrigerated — chilled storage',
    ambient:      'Ambient — room temperature / dry store',
  }

  const color = COLOR[s]

  return (
    <span
      title={TITLE[s]}
      style={{
        display: 'inline-flex', alignItems: 'center',
        width: size, height: size, verticalAlign: 'middle',
        flexShrink: 0,
      }}
    >
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
        {s === 'frozen' && (
          // Snowflake — six spokes + small caps
          <g stroke={color} strokeWidth="1.4" strokeLinecap="round" fill="none">
            <line x1="8" y1="2"  x2="8"  y2="14" />
            <line x1="3" y1="5"  x2="13" y2="11" />
            <line x1="3" y1="11" x2="13" y2="5"  />
            <line x1="8" y1="2"  x2="7" y2="3" />
            <line x1="8" y1="2"  x2="9" y2="3" />
            <line x1="8" y1="14" x2="7" y2="13" />
            <line x1="8" y1="14" x2="9" y2="13" />
          </g>
        )}
        {s === 'refrigerated' && (
          // Droplet — chilled / wet zone
          <path
            d="M8 2 C8 2 4 7 4 10 a4 4 0 0 0 8 0 C12 7 8 2 8 2 Z"
            fill={color} opacity="0.85"
          />
        )}
        {s === 'ambient' && (
          // Small sun — dry / room temp
          <g stroke={color} strokeWidth="1.4" strokeLinecap="round" fill="none">
            <circle cx="8" cy="8" r="3" fill={color} opacity="0.3" />
            <circle cx="8" cy="8" r="3" />
            <line x1="8" y1="2"  x2="8"  y2="3.5" />
            <line x1="8" y1="12.5" x2="8" y2="14" />
            <line x1="2" y1="8"  x2="3.5"  y2="8" />
            <line x1="12.5" y1="8" x2="14" y2="8" />
            <line x1="3.5" y1="3.5"  x2="4.5"  y2="4.5" />
            <line x1="11.5" y1="11.5" x2="12.5" y2="12.5" />
            <line x1="3.5" y1="12.5"  x2="4.5"  y2="11.5" />
            <line x1="11.5" y1="4.5" x2="12.5" y2="3.5" />
          </g>
        )}
      </svg>
    </span>
  )
}

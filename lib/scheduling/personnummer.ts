// lib/scheduling/personnummer.ts
//
// Shared, PII-careful parsing of a Swedish personnummer / birth date into a
// plain birth DATE (no identity digits retained) plus age helpers. Used by
// both the Caspeco roster sync (lib/sync/engine.ts) and the Personalkollen
// staff sync (lib/scheduling/pk-sync.ts) so minor-detection logic lives in
// ONE place.
//
// Handles:
//   · 12-digit YYYYMMDDXXXX
//   · 10-digit YYMMDD-XXXX (century inferred; '+' separator not distinguished —
//     irrelevant for under-18 detection)
//   · samordningsnummer (coordination number): day is real day + 60
//   · an explicit ISO date string ('YYYY-MM-DD…')
// Returns null when the input doesn't yield a valid calendar date.

export function birthDateFromPersonnummer(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const str = String(raw).trim()
  if (!str) return null

  // Explicit ISO date.
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const d = `${iso[1]}-${iso[2]}-${iso[3]}`
    return isRealDate(d, +iso[1], +iso[2], +iso[3]) ? d : null
  }

  const digits = str.replace(/\D/g, '')
  let yr: number, mo: number, dy: number
  if (digits.length === 12) {
    yr = +digits.slice(0, 4); mo = +digits.slice(4, 6); dy = +digits.slice(6, 8)
  } else if (digits.length === 10) {
    const yy = +digits.slice(0, 2)
    const nowYY = new Date().getUTCFullYear() % 100
    yr = (yy <= nowYY ? 2000 : 1900) + yy   // 2-digit year → century inference
    mo = +digits.slice(2, 4); dy = +digits.slice(4, 6)
  } else {
    return null
  }
  if (dy > 60) dy -= 60   // samordningsnummer
  if (!(mo >= 1 && mo <= 12) || !(dy >= 1 && dy <= 31)) return null
  const d = `${String(yr).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`
  return isRealDate(d, yr, mo, dy) ? d : null
}

// Reject invalid calendar dates (e.g. Feb 30) by round-tripping through Date.
function isRealDate(iso: string, yr: number, mo: number, dy: number): boolean {
  const t = new Date(iso + 'T00:00:00Z')
  if (!Number.isFinite(t.getTime())) return false
  return t.getUTCFullYear() === yr && t.getUTCMonth() + 1 === mo && t.getUTCDate() === dy
}

export function ageFromBirthDate(birthIso: string): number {
  const b = new Date(birthIso + 'T00:00:00Z')
  const now = new Date()
  let age = now.getUTCFullYear() - b.getUTCFullYear()
  const m = now.getUTCMonth() - b.getUTCMonth()
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--
  return age
}

/** True when the personnummer/birth date resolves to someone under 18. */
export function isMinorFromPersonnummer(raw: string | null | undefined): boolean {
  const b = birthDateFromPersonnummer(raw)
  return b != null && ageFromBirthDate(b) < 18
}

// lib/mock/schedule.ts
//
// Phase 6 — vision data for the full Schedule grid. Shape mirrors what a
// real /api/scheduling/grid would emit: per-employee rows grouped by
// department, with one shift block per day. Forecast vs. mål totals
// drive the header strip.

export type ShiftStatus = 'planned' | 'open' | 'unavailable' | 'draft'

export interface MockShift {
  day_idx:   number     // 0 = Monday … 6 = Sunday
  start:     string     // "16:00"
  end:       string     // "23:30"
  status:    ShiftStatus
  hours:     number     // computed (end - start - breaks)
  role?:     string
}

export interface MockEmployee {
  id:               string
  name:             string
  contracted_hours: number
  shifts:           MockShift[]
}

export interface MockDepartment {
  name:      string
  employees: MockEmployee[]
}

export interface MockScheduleData {
  status_label:    'Utkast' | 'Inskickad' | 'Publicerad'
  prognos_revenue: number
  mal_revenue:     number
  prognos_hours:   number
  mal_hours:       number
  current_hours:   number
  ai_added_hours:  number
  week_label:      string
  departments:     MockDepartment[]
}

const DAY_LABELS = ['Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör', 'Sön']
export { DAY_LABELS as MOCK_SCHEDULE_DAY_LABELS }

function shift(day_idx: number, start: string, end: string, status: ShiftStatus = 'planned', role?: string): MockShift {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const mins = (eh * 60 + em) - (sh * 60 + sm) - 30  // 30 min implied break
  return { day_idx, start, end, status, role, hours: +(mins / 60).toFixed(1) }
}

export const MOCK_SCHEDULE: MockScheduleData = {
  status_label:    'Utkast',
  prognos_revenue: 248_500,
  mal_revenue:     265_000,
  prognos_hours:   312,
  mal_hours:       298,
  current_hours:   286,
  ai_added_hours:  184,
  week_label:      'Vecka 21 · 18–24 maj',
  departments: [
    {
      name: 'Kök',
      employees: [
        {
          id: 'emp-1', name: 'Alessia Romano', contracted_hours: 32,
          shifts: [
            shift(0, '15:00', '23:00', 'planned', 'Köksmästare'),
            shift(1, '15:00', '23:00', 'planned', 'Köksmästare'),
            shift(3, '15:00', '23:30', 'planned', 'Köksmästare'),
            shift(4, '15:00', '23:30', 'planned', 'Köksmästare'),
          ],
        },
        {
          id: 'emp-2', name: 'Lucas Berg', contracted_hours: 38,
          shifts: [
            shift(0, '15:30', '23:00', 'planned', 'Pizzaiolo'),
            shift(1, '15:30', '23:00', 'planned', 'Pizzaiolo'),
            shift(2, '15:30', '23:00', 'planned', 'Pizzaiolo'),
            shift(4, '15:30', '00:00', 'planned', 'Pizzaiolo'),
            shift(5, '15:30', '00:00', 'planned', 'Pizzaiolo'),
          ],
        },
        {
          id: 'emp-3', name: 'Maja Andersson', contracted_hours: 24,
          shifts: [
            shift(0, '11:00', '15:00', 'planned', 'Lunchkock'),
            shift(1, '11:00', '15:00', 'planned', 'Lunchkock'),
            shift(2, '11:00', '15:00', 'planned', 'Lunchkock'),
            shift(3, '11:00', '15:00', 'planned', 'Lunchkock'),
            { day_idx: 4, start: '—', end: '—', status: 'unavailable', hours: 0 },
            shift(5, '11:00', '15:30', 'planned', 'Lunchkock'),
          ],
        },
        {
          id: 'emp-4', name: 'Open kock-skift', contracted_hours: 0,
          shifts: [
            shift(5, '17:00', '23:30', 'open', 'Allt-i-allo'),
            shift(6, '12:00', '20:00', 'open', 'Allt-i-allo'),
          ],
        },
      ],
    },
    {
      name: 'Servis',
      employees: [
        {
          id: 'emp-5', name: 'Linnea Holm', contracted_hours: 38,
          shifts: [
            shift(0, '16:00', '23:30', 'planned', 'Servis'),
            shift(1, '16:00', '23:30', 'planned', 'Servis'),
            shift(2, '16:00', '23:30', 'planned', 'Servis'),
            shift(4, '16:00', '00:30', 'planned', 'Servis'),
            shift(5, '16:00', '00:30', 'planned', 'Servis'),
          ],
        },
        {
          id: 'emp-6', name: 'Mikael Lindgren', contracted_hours: 24,
          shifts: [
            shift(3, '16:00', '23:30', 'planned', 'Bar'),
            shift(4, '16:00', '00:30', 'planned', 'Bar'),
            shift(5, '16:00', '00:30', 'planned', 'Bar'),
          ],
        },
        {
          id: 'emp-7', name: 'Sara Eklund', contracted_hours: 16,
          shifts: [
            { day_idx: 0, start: '—', end: '—', status: 'unavailable', hours: 0 },
            { day_idx: 1, start: '—', end: '—', status: 'unavailable', hours: 0 },
            shift(2, '17:00', '23:30', 'planned', 'Servis'),
            shift(5, '17:00', '23:30', 'planned', 'Servis'),
          ],
        },
        {
          id: 'emp-8', name: 'Open servis-skift', contracted_hours: 0,
          shifts: [
            shift(4, '11:00', '15:00', 'open', 'Lunch'),
            shift(6, '12:00', '17:00', 'open', 'Brunch'),
          ],
        },
      ],
    },
  ],
}

// lib/mock/counts.ts
//
// Phase 6 — stock-count report mock. The shape mirrors the report a
// real Inventory-counts feature would emit: opening + deliveries +
// transfers in/out + closing = consumed, with a side-by-side "sold"
// column so the operator can eyeball variance per ingredient.

export interface MockCountRow {
  item_id:      string
  name:         string
  unit:         string
  /** Vara (the article column on the report). */
  article:      string
  ingaende:     number   // Opening stock
  leverans:     number   // Deliveries (+)
  overfort_in:  number   // Transfers IN  (+)
  overfort_ut:  number   // Transfers OUT (−)
  utgaende:     number   // Closing stock
  forbrukat:    number   // Consumed (= ingaende + leverans + in − ut − utgaende)
  sald:         number   // Sold (per recipe theoretical)
  varians:      number   // forbrukat − sald
}

function row(
  item_id: string,
  name: string,
  unit: string,
  article: string,
  ingaende: number,
  leverans: number,
  overfort_in: number,
  overfort_ut: number,
  utgaende: number,
  sald: number,
): MockCountRow {
  const forbrukat = ingaende + leverans + overfort_in - overfort_ut - utgaende
  return {
    item_id, name, unit, article,
    ingaende, leverans, overfort_in, overfort_ut, utgaende,
    forbrukat, sald, varians: forbrukat - sald,
  }
}

export const MOCK_COUNT_ROWS: MockCountRow[] = [
  row('inv-001', 'San Marzano-tomater', 'kg', '4011 · Råvaror',  18.5, 30.0,  0.0, 1.5, 12.0, 32.0),
  row('inv-002', 'Mozzarella di Bufala', 'kg', '4011 · Råvaror',   8.4, 20.0,  0.0, 0.0,  6.2, 21.5),
  row('inv-003', 'Tipo 00-mjöl',        'kg', '4011 · Råvaror',  42.0, 25.0,  0.0, 0.0, 30.0, 35.5),
  row('inv-004', 'Olivolja extra',       'L', '4011 · Råvaror',  12.0,  5.0,  0.0, 0.0,  9.5,  7.4),
  row('inv-005', 'Parmigiano Reggiano', 'kg', '4011 · Råvaror',   6.0,  3.0,  0.0, 0.0,  3.5,  5.2),
  row('inv-006', 'Prosciutto di Parma',  'g', '4011 · Råvaror', 2400, 1500,    0,   0, 1200, 2600),
  row('inv-007', 'Pinot Grigio (glas)', 'st', '4019 · Drycker',    62,  120,    0,   0,   48,  131),
  row('inv-008', 'Chianti Classico',    'st', '4019 · Drycker',    36,   72,    0,   0,   28,   78),
  row('inv-012', 'Spaghetti #5',        'kg', '4011 · Råvaror',  15.0, 12.0,  0.0, 0.0,  9.0, 16.4),
  row('inv-013', 'Rom-tomater',         'kg', '4011 · Råvaror',   8.0, 15.0,  0.0, 0.0,  3.4, 18.2),
  row('inv-014', 'Espressobönor',       'kg', '4011 · Råvaror',   3.4,  2.0,  0.0, 0.0,  1.5,  3.6),
]

// Footer totals (SUMMA row on the report)
export function mockCountFooter() {
  return {
    ingaende:    sum(r => r.ingaende),
    leverans:    sum(r => r.leverans),
    overfort_in: sum(r => r.overfort_in),
    overfort_ut: sum(r => r.overfort_ut),
    utgaende:    sum(r => r.utgaende),
    forbrukat:   sum(r => r.forbrukat),
    sald:        sum(r => r.sald),
    varians:     sum(r => r.varians),
  }
}

function sum(pick: (r: MockCountRow) => number) {
  return Math.round(MOCK_COUNT_ROWS.reduce((s, r) => s + pick(r), 0) * 100) / 100
}

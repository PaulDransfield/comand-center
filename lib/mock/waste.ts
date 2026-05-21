// lib/mock/waste.ts
//
// Phase 6 — vision data for the waste log. Per-ingredient and per-reason
// rollups for the same rolling 30-day window. Real path will replace the
// arrays with /api/inventory/waste returning the same shapes.

export interface MockWasteReason {
  reason:  string
  count:   number   // how many waste events this period
  value:   number   // total SEK
}

export interface MockWasteIngredient {
  item_id:        string
  name:           string
  category:       string
  value:          number   // total SEK wasted this period
  top_reason:     string
  events:         number
}

export const MOCK_WASTE_REASONS: MockWasteReason[] = [
  { reason: 'Bäst före utgånget',     count: 28, value: 4_120 },
  { reason: 'Felaktigt förvarat',     count: 14, value: 2_640 },
  { reason: 'Spill / tappat',         count: 22, value: 1_980 },
  { reason: 'Förbereddes, ej såldes', count: 19, value: 3_410 },
  { reason: 'Inkommande skada',       count:  6, value:   980 },
]

export const MOCK_WASTE_INGREDIENTS: MockWasteIngredient[] = [
  { item_id: 'inv-013', name: 'Rom-tomater',         category: 'Grönsaker', value: 1_840, top_reason: 'Bäst före utgånget',     events: 12 },
  { item_id: 'inv-002', name: 'Mozzarella di Bufala', category: 'Mejeri',    value: 1_620, top_reason: 'Felaktigt förvarat',     events:  6 },
  { item_id: 'inv-010', name: 'Basilika',             category: 'Örter',     value: 1_280, top_reason: 'Bäst före utgånget',     events: 14 },
  { item_id: 'inv-001', name: 'San Marzano-tomater',  category: 'Konserver', value:   940, top_reason: 'Förbereddes, ej såldes', events:  7 },
  { item_id: 'inv-006', name: 'Prosciutto di Parma',  category: 'Chark',     value:   810, top_reason: 'Felaktigt förvarat',     events:  4 },
  { item_id: 'inv-009', name: 'Bryggjäst',            category: 'Torrvaror', value:   460, top_reason: 'Bäst före utgånget',     events:  5 },
  { item_id: 'inv-005', name: 'Parmigiano Reggiano',  category: 'Mejeri',    value:   420, top_reason: 'Spill / tappat',         events:  3 },
  { item_id: 'inv-014', name: 'Espressobönor',        category: 'Kaffe',     value:   280, top_reason: 'Spill / tappat',         events:  2 },
]

export const MOCK_WASTE_TOTAL_VALUE = MOCK_WASTE_INGREDIENTS.reduce((s, r) => s + r.value, 0)
export const MOCK_WASTE_TOTAL_EVENTS = MOCK_WASTE_REASONS.reduce((s, r) => s + r.count, 0)

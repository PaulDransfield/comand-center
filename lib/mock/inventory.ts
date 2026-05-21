// lib/mock/inventory.ts
//
// Phase 6 — vision data for the Inventory item master. Isolated here so
// app/inventory/items/page.tsx never inlines fixtures. Swap to real data
// later by replacing the export with a fetch + identical shape.

export interface MockInventoryItem {
  id:               string
  name:             string
  type:             'Råvara' | 'Förbrukning' | 'Dryck' | 'Tillagad'
  category:         string
  main_supplier:    string
  order_unit:       string          // e.g. "låda 6×1 kg"
  price_sek:        number          // per order_unit
  vat_pct:          12 | 25 | 6
  storage_areas:    string[]
  pack_size:        string          // "6 × 1 kg"
  count_units:      string[]        // e.g. ["kg", "g"]
}

// Compact set — enough variety to surface filters, long names, and
// suppliers across multiple categories. Real data will replace this
// with an /api/inventory/items fetch returning the same shape.
export const MOCK_INVENTORY_ITEMS: MockInventoryItem[] = [
  {
    id: 'inv-001', name: 'San Marzano-tomater, krossade',
    type: 'Råvara', category: 'Konserver',
    main_supplier: 'Martin & Servera',
    order_unit: 'kartong 6 × 2.5 kg', price_sek: 489, vat_pct: 12,
    storage_areas: ['Torrlager'], pack_size: '6 × 2.5 kg',
    count_units: ['burk', 'kg'],
  },
  {
    id: 'inv-002', name: 'Mozzarella di Bufala DOP',
    type: 'Råvara', category: 'Mejeri',
    main_supplier: 'Italmarknaden',
    order_unit: 'låda 12 × 125 g', price_sek: 612, vat_pct: 12,
    storage_areas: ['Kyl 1'], pack_size: '12 × 125 g',
    count_units: ['st', 'g'],
  },
  {
    id: 'inv-003', name: 'Tipo 00-mjöl Caputo',
    type: 'Råvara', category: 'Torrvaror',
    main_supplier: 'Martin & Servera',
    order_unit: 'säck 25 kg', price_sek: 348, vat_pct: 12,
    storage_areas: ['Torrlager'], pack_size: '25 kg',
    count_units: ['kg', 'g'],
  },
  {
    id: 'inv-004', name: 'Olivolja extra jungfru, Toscana DOP',
    type: 'Råvara', category: 'Oljor & vinäger',
    main_supplier: 'Italmarknaden',
    order_unit: 'flaska 5 L', price_sek: 689, vat_pct: 12,
    storage_areas: ['Torrlager'], pack_size: '5 L',
    count_units: ['L', 'ml'],
  },
  {
    id: 'inv-005', name: 'Parmigiano Reggiano 24 mån',
    type: 'Råvara', category: 'Mejeri',
    main_supplier: 'Italmarknaden',
    order_unit: 'bit 1 kg', price_sek: 525, vat_pct: 12,
    storage_areas: ['Kyl 1'], pack_size: '1 kg',
    count_units: ['kg', 'g'],
  },
  {
    id: 'inv-006', name: 'Prosciutto di Parma 18 mån, skivat',
    type: 'Råvara', category: 'Chark',
    main_supplier: 'Italmarknaden',
    order_unit: 'förpackning 500 g', price_sek: 412, vat_pct: 12,
    storage_areas: ['Kyl 2'], pack_size: '500 g',
    count_units: ['g'],
  },
  {
    id: 'inv-007', name: 'Pinot Grigio, hus-vitt, BIB',
    type: 'Dryck', category: 'Vin',
    main_supplier: 'Systembolaget Restaurang',
    order_unit: 'BIB 5 L', price_sek: 489, vat_pct: 25,
    storage_areas: ['Vinkällare'], pack_size: '5 L',
    count_units: ['glas', 'flaska'],
  },
  {
    id: 'inv-008', name: 'Chianti Classico DOCG, husrött',
    type: 'Dryck', category: 'Vin',
    main_supplier: 'Systembolaget Restaurang',
    order_unit: 'kartong 6 × 0.75 L', price_sek: 1340, vat_pct: 25,
    storage_areas: ['Vinkällare'], pack_size: '6 × 0.75 L',
    count_units: ['flaska', 'glas'],
  },
  {
    id: 'inv-009', name: 'Bryggjäst, färsk',
    type: 'Råvara', category: 'Torrvaror',
    main_supplier: 'Martin & Servera',
    order_unit: 'kilo', price_sek: 89, vat_pct: 12,
    storage_areas: ['Kyl 1'], pack_size: '1 kg',
    count_units: ['g', 'kg'],
  },
  {
    id: 'inv-010', name: 'Basilika, färsk',
    type: 'Råvara', category: 'Örter & kryddor',
    main_supplier: 'Grönsakshallen',
    order_unit: 'kruka', price_sek: 19, vat_pct: 12,
    storage_areas: ['Kyl 1'], pack_size: '50 g',
    count_units: ['kruka', 'g'],
  },
  {
    id: 'inv-011', name: 'Vitt vinäger, Aceto Bianco',
    type: 'Råvara', category: 'Oljor & vinäger',
    main_supplier: 'Italmarknaden',
    order_unit: 'flaska 1 L', price_sek: 79, vat_pct: 12,
    storage_areas: ['Torrlager'], pack_size: '1 L',
    count_units: ['L', 'ml'],
  },
  {
    id: 'inv-012', name: 'Spaghetti #5, De Cecco',
    type: 'Råvara', category: 'Torrvaror',
    main_supplier: 'Martin & Servera',
    order_unit: 'kartong 12 × 500 g', price_sek: 312, vat_pct: 12,
    storage_areas: ['Torrlager'], pack_size: '12 × 500 g',
    count_units: ['paket', 'g', 'kg'],
  },
  {
    id: 'inv-013', name: 'Rom-tomater, färska',
    type: 'Råvara', category: 'Grönsaker',
    main_supplier: 'Grönsakshallen',
    order_unit: 'låda 5 kg', price_sek: 178, vat_pct: 12,
    storage_areas: ['Kyl 2'], pack_size: '5 kg',
    count_units: ['kg', 'st'],
  },
  {
    id: 'inv-014', name: 'Espressobönor, husblandning 1 kg',
    type: 'Dryck', category: 'Kaffe & te',
    main_supplier: 'Java Roasters',
    order_unit: 'påse 1 kg', price_sek: 285, vat_pct: 12,
    storage_areas: ['Torrlager'], pack_size: '1 kg',
    count_units: ['kg', 'g', 'kopp'],
  },
  {
    id: 'inv-015', name: 'Servetter 24×24 cm, vita 2-lager',
    type: 'Förbrukning', category: 'Engångsartiklar',
    main_supplier: 'Martin & Servera',
    order_unit: 'kartong 6000 st', price_sek: 489, vat_pct: 25,
    storage_areas: ['Förråd'], pack_size: '6000 st',
    count_units: ['st', 'paket'],
  },
]

// Hard-coded total so the pagination footer can read like real data
// ("1–50 av 418") while the visible slice stays compact.
export const MOCK_INVENTORY_TOTAL = 418

// components/overheads/types.ts
//
// Shared types for the redesigned overhead-review components. Mirrors the
// shape returned by /api/overheads/flags.

export type Category = 'other_cost' | 'food_cost'

export type FlagType =
  | 'new_supplier'
  | 'price_spike'
  | 'dismissed_reappeared'
  | 'one_off_high'
  | 'duplicate_supplier'

export type FlagTypeFilter =
  | 'all'
  | 'price_spike'
  | 'dismissed_reappeared'
  | 'new_supplier'
  | 'one_off_high'

export type CategoryFilter = 'all' | 'other_cost' | 'food_cost'

export interface Flag {
  id:                       string
  supplier_name:            string
  supplier_name_normalised: string
  category:                 Category
  flag_type:                FlagType
  reason:                   string | null
  amount_sek:               number
  prior_avg_sek:            number | null
  period_year:              number
  period_month:             number
  surfaced_at:              string
  resolution_status:        'pending' | 'essential' | 'dismissed' | 'deferred'
  resolved_at:              string | null
  resolved_by:              string | null
  defer_until:              string | null
  ai_explanation:           string | null
  ai_confidence:            number | null
}

// One row in the list pane = one (supplier, category) group across periods.
export interface FlagGroup {
  key:          string  // `${normalised}::${category}`
  latest:       Flag
  others:       Flag[]
  latestKey:    number  // year*100 + month — sortable
  pendingCount: number  // pending flags inside the group (drives "+N periods")
  totalAmount:  number  // sum of pending amounts inside the group
}

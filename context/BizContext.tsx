// context/BizContext.tsx
//
// The MULTI-BUSINESS CONTEXT — the central brain of the dashboard.
//
// In the HTML prototype this was a vanilla-JS closure called BizContext.
// Here it's a proper React Context with useReducer, so any component can:
//   - Read the current business: const { current } = useBiz()
//   - Switch business:           const { select } = useBiz()
//   - Toggle aggregate view:     const { setAggregate } = useBiz()
//
// Wrap your app in <BizProvider> once (in the dashboard layout),
// then call useBiz() anywhere inside.

'use client'

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react'

// ── Types ─────────────────────────────────────────────────────────

// One restaurant location's financial snapshot
export interface Business {
  id:           string
  name:         string
  type:         string | null
  city:         string | null
  org_number:   string | null
  colour:       string
  // Financial targets (set by user in settings)
  target_staff_pct:  number
  target_food_pct:   number
  target_rent_pct:   number
  target_margin_pct: number
  // Latest month's actuals (from tracker_data table)
  revenue:    number
  staff_cost: number
  food_cost:  number
  rent_cost:  number
  other_cost: number
  net_profit: number
  margin:     number
  // Derived percentages
  staffPct: number
  foodPct:  number
  rentPct:  number
}

// The rolled-up numbers across all businesses
export interface AggregateData {
  revenue:  number
  profit:   number
  margin:   number   // weighted average
  staffPct: number
  foodPct:  number
  rentPct:  number
  count:    number
  contributions: Array<{
    id:      string
    name:    string
    colour:  string
    pct:     number   // % of total revenue
    revenue: number
    profit:  number
    margin:  number
  }>
}

// Everything the context exposes
interface BizState {
  businesses:   Business[]
  currentId:    string | null
  isAggregate:  boolean
  recentIds:    string[]
  loading:      boolean
  error:        string | null
}

interface BizContextValue extends BizState {
  // Derived — computed from state
  current:      Business | null
  canAggregate: boolean
  aggregate:    AggregateData | null
  // Actions
  select:       (id: string) => void
  setAggregate: (on: boolean) => void
  refresh:      () => void
}

// ── Colours for business avatars ──────────────────────────────────

const COLOURS = [
  '#2D5A27','#1A3F6B','#7A3B1E','#4A237A','#1A5F5F',
  '#6B4C1A','#3A1A5A','#1A4A3A','#5A1A2A','#2A4A6B',
]

export function colourForIndex(i: number): string {
  return COLOURS[i % COLOURS.length]
}

// ── Reducer ───────────────────────────────────────────────────────

type Action =
  | { type: 'SET_BUSINESSES'; businesses: Business[] }
  | { type: 'SET_CURRENT';    id: string }
  | { type: 'SET_AGGREGATE';  on: boolean }
  | { type: 'SET_LOADING';    loading: boolean }
  | { type: 'SET_ERROR';      error: string | null }

function reducer(state: BizState, action: Action): BizState {
  switch (action.type) {
    case 'SET_BUSINESSES':
      return { ...state, businesses: action.businesses, loading: false, error: null }

    case 'SET_CURRENT':
      return { ...state, currentId: action.id, isAggregate: false,
               recentIds: [action.id, ...state.recentIds.filter(r => r !== action.id)].slice(0, 5) }

    case 'SET_AGGREGATE':
      return { ...state, isAggregate: action.on, currentId: action.on ? null : state.currentId }

    case 'SET_LOADING':
      return { ...state, loading: action.loading }

    case 'SET_ERROR':
      return { ...state, error: action.error, loading: false }

    default:
      return state
  }
}

// ── Aggregate calculation ─────────────────────────────────────────
// Same maths as the HTML prototype's computeAggregate() function

function computeAggregate(businesses: Business[]): AggregateData | null {
  if (!businesses.length) return null

  const total    = businesses.reduce((a, b) => a + (b.revenue || 0), 0)
  const profit   = businesses.reduce((a, b) => a + (b.net_profit || 0), 0)
  const margin   = total > 0 ? Math.round(profit / total * 1000) / 10 : 0

  // Weighted average cost percentages (weighted by each business's revenue)
  const staffCost = businesses.reduce((a, b) => a + (b.revenue || 0) * (b.staffPct || 0) / 100, 0)
  const foodCost  = businesses.reduce((a, b) => a + (b.revenue || 0) * (b.foodPct  || 0) / 100, 0)
  const rentCost  = businesses.reduce((a, b) => a + (b.revenue || 0) * (b.rentPct  || 0) / 100, 0)

  return {
    revenue:  total,
    profit,
    margin,
    staffPct: total > 0 ? Math.round(staffCost / total * 100) : 0,
    foodPct:  total > 0 ? Math.round(foodCost  / total * 100) : 0,
    rentPct:  total > 0 ? Math.round(rentCost  / total * 100) : 0,
    count:    businesses.length,
    contributions: businesses.map(b => ({
      id:      b.id,
      name:    b.name,
      colour:  b.colour,
      pct:     total > 0 ? Math.round((b.revenue || 0) / total * 100) : 0,
      revenue: b.revenue || 0,
      profit:  b.net_profit || 0,
      margin:  b.margin || 0,
    })),
  }
}

// ── Context ───────────────────────────────────────────────────────

const BizContext = createContext<BizContextValue | null>(null)

const STORAGE_KEY = 'cc_biz_state_v1'

function loadStoredState(): Partial<BizState> {
  if (typeof window === 'undefined') return {}
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return {}
    const { currentId, isAggregate, recentIds } = JSON.parse(stored)
    return { currentId, isAggregate, recentIds }
  } catch {
    return {}
  }
}

// ── Provider ──────────────────────────────────────────────────────

export function BizProvider({ children }: { children: ReactNode }) {
  const stored = loadStoredState()

  const [state, dispatch] = useReducer(reducer, {
    businesses:  [],
    currentId:   stored.currentId   ?? null,
    isAggregate: stored.isAggregate ?? false,
    recentIds:   stored.recentIds   ?? [],
    loading:     true,
    error:       null,
  })

  // Persist selection to localStorage whenever it changes
  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      currentId:   state.currentId,
      isAggregate: state.isAggregate,
      recentIds:   state.recentIds,
    }))
  }, [state.currentId, state.isAggregate, state.recentIds])

  // Fetch businesses from the API
  const fetchBusinesses = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', loading: true })
    try {
      const res = await fetch('/api/businesses')
      if (!res.ok) throw new Error('Failed to load businesses')
      const data: Business[] = await res.json()

      dispatch({ type: 'SET_BUSINESSES', businesses: data })

      // Auto-select first business if nothing is selected yet
      if (!state.currentId && !state.isAggregate && data.length > 0) {
        dispatch({ type: 'SET_CURRENT', id: data[0].id })
      }
    } catch (err) {
      dispatch({ type: 'SET_ERROR', error: (err as Error).message })
    }
  }, [state.currentId, state.isAggregate])

  // Load businesses on mount
  useEffect(() => { fetchBusinesses() }, []) // eslint-disable-line

  // Derived values (memoised so they only recompute when businesses change)
  const current = useMemo(
    () => state.businesses.find(b => b.id === state.currentId) ?? null,
    [state.businesses, state.currentId]
  )

  const aggregate = useMemo(
    () => computeAggregate(state.businesses),
    [state.businesses]
  )

  const value: BizContextValue = {
    ...state,
    current,
    canAggregate: state.businesses.length >= 2,
    aggregate,
    select:       (id: string) => dispatch({ type: 'SET_CURRENT', id }),
    setAggregate: (on: boolean) => dispatch({ type: 'SET_AGGREGATE', on }),
    refresh:      fetchBusinesses,
  }

  return <BizContext.Provider value={value}>{children}</BizContext.Provider>
}

// ── Hook ──────────────────────────────────────────────────────────

// Call this inside any component to access business state
export function useBiz(): BizContextValue {
  const ctx = useContext(BizContext)
  if (!ctx) throw new Error('useBiz() must be used inside <BizProvider>')
  return ctx
}

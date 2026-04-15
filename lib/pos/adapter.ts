// @ts-nocheck
// lib/pos/adapter.ts
// Generic POS adapter interface + registry of all available adapters

export interface DailyCoverData {
  date:      string
  breakfast: number
  lunch:     number
  dinner:    number
  takeaway:  number
  catering:  number
  other:     number
  revenue:   number
  source:    string
}

export interface POSAdapter {
  name:        string
  key:         string
  description: string
  docsUrl:     string
  testConnection(credentials: Record<string, string>, config: Record<string, any>): Promise<{
    ok: boolean; error?: string; info?: Record<string, any>
  }>
  fetchCovers(credentials: Record<string, string>, config: Record<string, any>, fromDate: string, toDate: string): Promise<DailyCoverData[]>
}

import { AnconAdapter }    from './ancon'
import { TrivecAdapter }   from './trivec'
import { ZettleAdapter }   from './zettle'
import { QuinyxAdapter }   from './quinyx'
import { WoltAdapter }     from './wolt'
import { FoodoraAdapter }  from './foodora'
import { TheForkAdapter }  from './thefork'
import { BokadAdapter }    from './bokad'
import { ManualAdapter }   from './manual'

export const POS_ADAPTERS: Record<string, POSAdapter> = {
  ancon:    new AnconAdapter(),
  trivec:   new TrivecAdapter(),
  zettle:   new ZettleAdapter(),
  quinyx:   new QuinyxAdapter(),
  wolt:     new WoltAdapter(),
  foodora:  new FoodoraAdapter(),
  thefork:  new TheForkAdapter(),
  bokad:    new BokadAdapter(),
  manual:   new ManualAdapter(),
}

export function getAdapter(posSystem: string): POSAdapter | null {
  return POS_ADAPTERS[posSystem] ?? null
}

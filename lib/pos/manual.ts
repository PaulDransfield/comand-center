// lib/pos/manual.ts
// Manual entry adapter — fallback when no POS is connected.
// Returns empty data since covers are entered manually via the UI.

import { POSAdapter, DailyCoverData } from './adapter'

export class ManualAdapter implements POSAdapter {
  name        = 'Manual Entry'
  key         = 'manual'
  description = 'Enter covers manually each day'
  docsUrl     = '/covers'

  async testConnection() {
    return { ok: true, info: { message: 'Manual entry — no connection needed' } }
  }

  async fetchCovers(): Promise<DailyCoverData[]> {
    return []  // Manual entries come from the UI, not pulled from an API
  }
}

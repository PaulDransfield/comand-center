// Swess/Inzii POS sync configuration
// Generated 2026-04-15
// 4 endpoints, 3 recommendations

export const SWESS_CONFIG = {
  provider: 'swess',
  endpoints: {
    api_sales: {
      path: '/api/sales',
      description: 'Sales transactions',
      fields: 15,
    },
    api_products: {
      path: '/api/products',
      description: 'Product catalog',
      fields: 12,
    },
    api_tables: {
      path: '/api/tables',
      description: 'Table management',
      fields: 8,
    },
    api_shifts: {
      path: '/api/shifts',
      description: 'Shift reports',
      fields: 10,
    },
  },
  recommendations: [
    {
      type: 'revenue_tracking',
      priority: 'high',
      reasoning: 'POS provides real-time revenue data with timestamps',
    },
    {
      type: 'product_analysis',
      priority: 'medium',
      reasoning: 'Product catalog enables menu profitability analysis',
    },
    {
      type: 'accounting_integration',
      priority: 'low',
      reasoning: 'Connected to Vero Italiano for accounting reconciliation',
    },
  ]
};
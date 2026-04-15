// Fortnox Accounting sync configuration
// Generated 2026-04-15
// 3 endpoints, 2 recommendations

export const FORTNOX_CONFIG = {
  provider: 'fortnox',
  endpoints: {
    supplierinvoices: {
      path: '/supplierinvoices',
      description: 'Supplier invoices (expenses)',
      fields: 9,
    },
    invoices: {
      path: '/invoices',
      description: 'Customer invoices (revenue)',
      fields: 8,
    },
    articles: {
      path: '/articles',
      description: 'Products/services',
      fields: 8,
    },
  },
  recommendations: [
    {
      type: 'new_endpoint',
      priority: 'high',
      reasoning: 'Currently only syncing supplier invoices (expenses), missing revenue data',
    },
    {
      type: 'new_endpoint',
      priority: 'medium',
      reasoning: 'Product-level data for granular sales analysis',
    },
  ]
};
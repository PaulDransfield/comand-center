// Personalkollen sync configuration
// Generated 2026-04-15
// 4 endpoints, 2 recommendations

export const PERSONALKOLLEN_CONFIG = {
  provider: 'personalkollen',
  endpoints: {
    staffs: {
      path: '/staffs/',
      description: 'Staff members',
      fields: 7,
    },
    logged_times: {
      path: '/logged-times/',
      description: 'Logged work hours',
      fields: 12,
    },
    sales: {
      path: '/sales/',
      description: 'Sales data',
      fields: 10,
    },
    cost_groups: {
      path: '/cost-groups/',
      description: 'Cost groups/departments',
      fields: 5,
    },
  },
  recommendations: [
    {
      type: 'analysis_opportunity',
      priority: 'high',
      reasoning: 'Combine staff hours with sales for revenue-per-employee analysis',
    },
    {
      type: 'data_enhancement',
      priority: 'medium',
      reasoning: 'Department categorization enables better cost allocation',
    },
  ]
};
// lib/ai/agent-registry.ts
//
// Canonical list of customer-facing AI agents. Each agent has:
//   - key:        feature_flags flag identifier (matches isAgentEnabled)
//   - name + description: copy for the /settings/ai-agents page
//   - cron_name:  matches cron_run_log.cron_name for last-run lookup
//   - schedule_human: human-readable schedule string
//   - plan_required: gates the toggle (null = all plans)
//   - request_types: ai_request_log.request_type values that count
//                    toward this agent's spend
//
// Used by:
//   - /api/settings/ai-agents (returns this list with live state)
//   - /settings/ai-agents page (renders cards)
//
// `customer_health_scoring` is intentionally NOT here — it's an
// admin-internal agent that runs against the operator's customer base,
// not a feature exposed to the operator themselves.

export type AgentPlan = null | 'pro' | 'group'

export interface AgentMeta {
  key:             string
  name:            string
  description:     string
  cron_name:       string
  schedule_human:  string
  plan_required:   AgentPlan
  request_types:   string[]
}

export const AGENTS: AgentMeta[] = [
  {
    key:             'anomaly_detection',
    name:            'Anomaly detection',
    description:     'Scans yesterday\'s revenue and labour data for unexpected spikes or drops. Sends an alert with a one-sentence AI explanation when something looks off.',
    cron_name:       'anomaly-check',
    schedule_human:  'Daily 06:30 UTC',
    plan_required:   null,
    request_types:   ['anomaly_explain'],
  },
  {
    key:             'onboarding_success',
    name:            'Onboarding welcome',
    description:     'Sends a personalised welcome email after the first successful integration sync. One-time per business, not recurring.',
    cron_name:       'onboarding-success',
    schedule_human:  'Daily 08:00 UTC (one-time per business)',
    plan_required:   null,
    request_types:   ['onboarding_welcome'],
  },
  {
    key:             'monday_briefing',
    name:            'Monday memo',
    description:     'Weekly email delivered every Monday morning. Three things to focus on for the week ahead, with SEK impact estimates. Uses last-week data + weather + holiday calendar.',
    cron_name:       'weekly-digest',
    schedule_human:  'Mon 07:00 (Stockholm)',
    plan_required:   'pro',
    request_types:   ['monday_briefing', 'weekly_manager_memo'],
  },
  {
    key:             'forecast_calibration',
    name:            'Forecast calibration',
    description:     'Monthly recalibration of the revenue forecaster. Compares the last month\'s predictions to actuals and adjusts bias factors per business. Pure arithmetic; no LLM call.',
    cron_name:       'forecast-calibration',
    schedule_human:  '1st of month 04:00 UTC',
    plan_required:   'pro',
    request_types:   [],
  },
  {
    key:             'supplier_price_creep',
    name:            'Supplier price drift',
    description:     'Monthly review of Fortnox supplier invoices. Flags suppliers whose unit prices have crept up vs the trailing 6 months. Includes an AI-generated explanation suggesting next steps.',
    cron_name:       'supplier-price-creep',
    schedule_human:  '1st of month 05:00 UTC',
    plan_required:   'pro',
    request_types:   ['supplier_price_drift'],
  },
  {
    key:             'scheduling_optimization',
    name:            'Scheduling AI',
    description:     'Weekly review of next-week\'s rota against predicted demand. Proposes per-meal-period cuts (never adds) with SEK savings estimates.',
    cron_name:       'scheduling-optimization',
    schedule_human:  'Mon 07:00 UTC',
    plan_required:   'group',
    request_types:   ['scheduling_optimization'],
  },
]

// Map cron_name → agent key for reverse lookup
export const AGENT_BY_CRON_NAME: Record<string, AgentMeta> = AGENTS.reduce((acc, a) => {
  acc[a.cron_name] = a
  return acc
}, {} as Record<string, AgentMeta>)

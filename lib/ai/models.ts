// lib/ai/models.ts
// Single source of truth for Anthropic model selection.
// Always use these constants — never hardcode model strings.

export const AI_MODELS = {
  AGENT:    'claude-haiku-4-5-20251001',
  ANALYSIS: 'claude-sonnet-4-6',
  ASSISTANT:'claude-sonnet-4-6',
} as const

export const MAX_TOKENS = {
  AGENT_EXPLANATION: 150,
  AGENT_SUMMARY: 300,
  AGENT_RECOMMENDATION: 400,
  ASSISTANT: 2000,
} as const

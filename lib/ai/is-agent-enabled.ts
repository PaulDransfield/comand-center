// lib/ai/is-agent-enabled.ts
// Check whether a specific agent is enabled for an org.
// Default: enabled. Only returns false if a feature_flags row exists with enabled=false.
// Used by agent crons to respect per-customer overrides set in the admin panel.

type Db = any

export async function isAgentEnabled(db: Db, orgId: string, agentKey: string): Promise<boolean> {
  try {
    const { data } = await db
      .from('feature_flags')
      .select('enabled')
      .eq('org_id', orgId)
      .eq('flag', `agent_${agentKey}`)
      .maybeSingle()
    // No row = not explicitly disabled = enabled
    return data?.enabled !== false
  } catch {
    // If feature_flags lookup fails, fail open (agent still runs) — this is a
    // non-critical check and we'd rather run the agent than block a customer silently.
    return true
  }
}

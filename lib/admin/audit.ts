// lib/admin/audit.ts
//
// Central helper for writing admin_audit_log rows. Every admin mutation
// must call this. Keep the payload PII-minimised — never include raw API keys,
// passwords, or customer personal data fields.

import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

export const ADMIN_ACTIONS = {
  // Identity / session
  LOGIN:            'login',
  IMPERSONATE:      'impersonate',
  // Org lifecycle
  EXTEND_TRIAL:     'extend_trial',
  TOGGLE_ACTIVE:    'toggle_active',
  HARD_DELETE:      'hard_delete',
  NOTE_ADD:         'note_add',
  NOTE_EDIT:        'note_edit',
  NOTE_DELETE:      'note_delete',
  NOTE_PIN:         'note_pin',
  // Integrations
  INTEGRATION_ADD:        'integration_add',
  INTEGRATION_KEY_EDIT:   'integration_key_edit',
  INTEGRATION_DELETE:     'integration_delete',
  INTEGRATION_TEST:       'integration_test',
  INTEGRATION_SYNC:       'integration_sync',
  DISCOVERY_RUN:          'discovery_run',
  DEPT_SETUP:             'dept_setup',
  // Agents
  AGENT_RUN:       'agent_run',
  AGENT_TOGGLE:    'agent_toggle',
  MASTER_SYNC:     'master_sync',
  // Tooling
  SQL_RUN:               'sql_run',
  INVESTIGATION_SAVE:    'investigation_save',
  INVESTIGATION_DELETE:  'investigation_delete',
  // Membership (M043 / FIXES §0az slice 2)
  MEMBER_INVITE:         'member_invite',
  MEMBER_UPDATE:         'member_update',
  MEMBER_REMOVE:         'member_remove',
} as const

export type AdminAction = typeof ADMIN_ACTIONS[keyof typeof ADMIN_ACTIONS]

export interface AuditInput {
  action:        AdminAction | string
  orgId?:        string | null
  integrationId?: string | null
  targetType?:   'org' | 'business' | 'integration' | 'user' | 'agent' | 'system' | null
  targetId?:     string | null
  payload?:      Record<string, any>
  actor?:        string                   // defaults to 'admin'
  req?:          NextRequest               // to grab IP + user agent
}

export async function recordAdminAction(db: SupabaseClient, input: AuditInput): Promise<void> {
  try {
    const ip = input.req?.headers.get('x-forwarded-for')?.split(',')[0].trim()
            ?? input.req?.headers.get('x-real-ip')
            ?? null
    const ua = input.req?.headers.get('user-agent') ?? null

    await db.from('admin_audit_log').insert({
      actor:         input.actor ?? 'admin',
      action:        input.action,
      org_id:        input.orgId ?? null,
      integration_id: input.integrationId ?? null,
      target_type:   input.targetType ?? null,
      target_id:     input.targetId ?? null,
      payload:       input.payload ?? null,
      ip_address:    ip,
      user_agent:    ua,
    })
  } catch (e: any) {
    // Audit write failures must never break the primary action — but must be visible in logs.
    // Why: a silently-missing audit row is a compliance incident (GDPR Art. 30,
    // Bokföringslagen traceability) — Sentry must surface this immediately.
    console.error('[admin_audit] write failed:', e?.message || e)
    try {
      const { captureError } = await import('@/lib/monitoring/sentry')
      captureError(e, {
        route:          'lib/admin/audit',
        phase:          'recordAdminAction',
        action:         input.action,
        actor:          input.actor ?? 'admin',
        org_id:         input.orgId,
        integration_id: input.integrationId,
        target_type:    input.targetType,
        target_id:      input.targetId,
      })
    } catch { /* monitoring must never break the request */ }
  }
}

'use client'
// app/admin/v2/customers/[orgId]/page.tsx
//
// Customer detail page. Main column on the left (header + sub-tab nav +
// active sub-tab content), right-rail action drawer on the right.
//
// PR 4 implements: Snapshot, Integrations, Data sub-tabs + 4 quick
// actions (Impersonate, Force sync, Reaggregate, Memo preview). Other
// sub-tabs (Billing, Users, Sync history, Audit, Danger zone) and right-
// rail sections (Subscription, Health probes, Danger zone) land in PR 5.
//
// FIXES.md §0ae.

import { useState, useCallback } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'
import { CustomerHeader } from '@/components/admin/v2/CustomerHeader'
import { CustomerSubtabs, type SubTab } from '@/components/admin/v2/CustomerSubtabs'
import { CustomerSnapshot } from '@/components/admin/v2/CustomerSnapshot'
import { CustomerIntegrations } from '@/components/admin/v2/CustomerIntegrations'
import { CustomerData } from '@/components/admin/v2/CustomerData'
import { CustomerBilling } from '@/components/admin/v2/CustomerBilling'
import { CustomerUsers } from '@/components/admin/v2/CustomerUsers'
import { CustomerSyncHistory } from '@/components/admin/v2/CustomerSyncHistory'
import { CustomerAudit } from '@/components/admin/v2/CustomerAudit'
import { CustomerDangerZone } from '@/components/admin/v2/CustomerDangerZone'
import { RightRail } from '@/components/admin/v2/RightRail'

interface SnapshotPayload {
  org: any
  businesses: any[]
}

export default function CustomerDetailPage({ params }: { params: { orgId: string } }) {
  const { orgId } = params
  const [activeTab, setActiveTab] = useState<SubTab>('snapshot')
  // Header data piggy-backs on the snapshot fetch — one less round-trip.
  const snapshot = useAdminData<SnapshotPayload>(`/api/admin/v2/customers/${orgId}/snapshot`)

  // Refetch trigger after a quick action runs (e.g. force sync) so the
  // snapshot's "recent admin trail" picks up the new audit row.
  const onActionComplete = useCallback(() => {
    snapshot.refetch()
  }, [snapshot])

  return (
    <div>
      {snapshot.error && (
        <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12, marginBottom: 14 }}>
          Couldn't load customer: {snapshot.error}
        </div>
      )}
      {snapshot.data && (
        <CustomerHeader
          org={snapshot.data.org}
          business_count={snapshot.data.businesses?.length ?? 0}
          owner_email={snapshot.data.org?.billing_email ?? null}
        />
      )}
      {!snapshot.data && snapshot.loading && (
        <HeaderSkeleton />
      )}

      <div style={{
        display:             'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 280px',
        gap:                 18,
      }}>
        <main style={{ minWidth: 0 }}>
          <CustomerSubtabs active={activeTab} onChange={setActiveTab} />
          {renderSubtab(activeTab, orgId, snapshot.data?.org?.name ?? orgId, onActionComplete)}
        </main>
        <RightRail
          orgId={orgId}
          currentPlan={snapshot.data?.org?.plan}
          onActionComplete={onActionComplete}
        />
      </div>
    </div>
  )
}

function renderSubtab(tab: SubTab, orgId: string, orgName: string, onComplete: () => void) {
  switch (tab) {
    case 'snapshot':     return <CustomerSnapshot orgId={orgId} />
    case 'integrations': return <CustomerIntegrations orgId={orgId} />
    case 'data':         return <CustomerData orgId={orgId} />
    case 'billing':      return <CustomerBilling orgId={orgId} />
    case 'users':        return <CustomerUsers orgId={orgId} />
    case 'sync_history': return <CustomerSyncHistory orgId={orgId} />
    case 'audit':        return <CustomerAudit orgId={orgId} />
    case 'danger':       return <CustomerDangerZone orgId={orgId} orgName={orgName} onComplete={onComplete} />
  }
}

function HeaderSkeleton() {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 14, height: 90 }}>
      <div style={{ width: 240, height: 22, background: '#f3f4f6', borderRadius: 4, marginBottom: 10 }} />
      <div style={{ width: 320, height: 12, background: '#f3f4f6', borderRadius: 4 }} />
    </div>
  )
}

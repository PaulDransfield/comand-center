// lib/fortnox/web-url.ts
//
// Build deep links into the Fortnox web app. Pattern:
//   https://apps2.fortnox.se/app/{workspace_id}/lf/supplierinvoice/{GivenNumber}
//   https://apps2.fortnox.se/app/{workspace_id}/bf/voucher/{Series}/{Number}
//
// workspace_id is a per-tenant 32-hex UUID Fortnox assigns. No public
// API exposes it — owner pastes their workspace URL once on
// /integrations and we extract the hex.
//
// When workspace_id is missing we return null and the caller drops the
// link rather than render a 404.

const HEX32 = /^[a-f0-9]{32}$/

/** Extract the workspace UUID from a Fortnox web URL the owner pastes.
 *  Handles both apps2.fortnox.se and apps.fortnox.se prefixes. */
export function extractWorkspaceId(pasted: string | null | undefined): string | null {
  if (!pasted) return null
  // First try strict URL parse
  try {
    const u = new URL(pasted)
    if (!/apps\d?\.fortnox\.se$/.test(u.host)) return null
    // path like /app/{hex}/...
    const parts = u.pathname.split('/').filter(Boolean)
    const idx = parts.indexOf('app')
    if (idx >= 0 && parts[idx + 1] && HEX32.test(parts[idx + 1])) return parts[idx + 1]
  } catch { /* fall through to raw regex */ }
  // Raw regex fallback — handles paste of just the hex or a partial URL
  const m = pasted.match(/([a-f0-9]{32})/)
  return m ? m[1] : null
}

export function supplierInvoiceUrl(workspaceId: string | null | undefined, givenNumber: string | null | undefined): string | null {
  if (!workspaceId || !HEX32.test(workspaceId)) return null
  if (!givenNumber) return null
  return `https://apps2.fortnox.se/app/${workspaceId}/lf/supplierinvoice/${encodeURIComponent(givenNumber)}`
}

export function voucherUrl(workspaceId: string | null | undefined, series: string | null | undefined, number: string | number | null | undefined): string | null {
  if (!workspaceId || !HEX32.test(workspaceId)) return null
  if (!series || number == null) return null
  return `https://apps2.fortnox.se/app/${workspaceId}/bf/voucher/${encodeURIComponent(series)}/${encodeURIComponent(String(number))}`
}

/** One-shot fetch of the Fortnox workspace_id for a business. Returns
 *  null when no Fortnox integration exists or the workspace_id hasn't
 *  been captured yet. Cheap (1 indexed lookup). */
export async function getFortnoxWorkspaceId(db: any, businessId: string): Promise<string | null> {
  const { data } = await db
    .from('integrations')
    .select('fortnox_workspace_id')
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .limit(1)
    .maybeSingle()
  return data?.fortnox_workspace_id ?? null
}

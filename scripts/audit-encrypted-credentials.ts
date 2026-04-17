// @ts-nocheck
// scripts/audit-encrypted-credentials.ts
//
// Verifies every row in `integrations` has a valid encrypted credential.
// Flags any row where credentials_enc is null, not base64, or fails decryption —
// those are the rows an attacker with DB access could exploit.
//
// Usage: npx tsx scripts/audit-encrypted-credentials.ts
// Requires: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, CREDENTIAL_ENCRYPTION_KEY

import { createClient } from '@supabase/supabase-js'
import { decrypt }      from '../lib/integrations/encryption'

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  if (!process.env.CREDENTIAL_ENCRYPTION_KEY) throw new Error('Set CREDENTIAL_ENCRYPTION_KEY')

  const db = createClient(url, key, { auth: { persistSession: false } })

  const { data, error } = await db
    .from('integrations')
    .select('id, org_id, provider, credentials_enc, status')
    .order('created_at', { ascending: false })

  if (error) throw error

  let ok = 0, missing = 0, corrupt = 0, suspicious = 0
  const problems: any[] = []

  for (const row of data ?? []) {
    if (!row.credentials_enc) {
      missing++; problems.push({ ...row, issue: 'credentials_enc is NULL' }); continue
    }
    // Encrypted blob is base64. Our format = 12-byte IV + ciphertext + 16-byte authTag
    // so minimum length is ~38 base64 chars. Anything shorter is almost certainly plaintext.
    if (row.credentials_enc.length < 38 || !/^[A-Za-z0-9+/=]+$/.test(row.credentials_enc)) {
      suspicious++; problems.push({ ...row, issue: 'Does not look like our base64 AES-GCM format' }); continue
    }
    try {
      const plain = decrypt(row.credentials_enc)
      if (!plain) throw new Error('decrypt returned empty')
      ok++
    } catch (e: any) {
      corrupt++; problems.push({ ...row, issue: `Decrypt failed: ${e.message}` })
    }
  }

  console.log(`\nIntegration credential audit — ${data?.length ?? 0} rows`)
  console.log(`  OK:         ${ok}`)
  console.log(`  Missing:    ${missing}`)
  console.log(`  Suspicious: ${suspicious}`)
  console.log(`  Corrupt:    ${corrupt}`)

  if (problems.length > 0) {
    console.log('\nProblems:')
    for (const p of problems) {
      console.log(`  [${p.provider}] org=${p.org_id.slice(0,8)} status=${p.status} — ${p.issue}`)
    }
    process.exit(1)
  }
  console.log('\nAll clean.')
}

main().catch(e => { console.error(e); process.exit(1) })

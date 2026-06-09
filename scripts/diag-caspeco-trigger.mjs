import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })

const INTEGRATION_BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

// Resolve the business
const { data: biz } = await db.from('businesses').select('id, name, org_id, country').eq('id', INTEGRATION_BIZ).maybeSingle()
console.log('Business attached:', biz)

// Check the integration row
const { data: integ } = await db.from('integrations').select('*').eq('business_id', INTEGRATION_BIZ).eq('provider', 'caspeco').maybeSingle()
console.log()
console.log('Integration metadata:', integ?.metadata)
console.log('Status:', integ?.status, ' Last sync:', integ?.last_sync_at, ' Last err:', integ?.last_error)

// Trigger sync via the cron endpoint with the secret
const CRON = '1fcc5dd3b457fbd00162cb3274076ed7ec2f13a684fbf6f01e7a1496842ba368'
console.log()
console.log('Triggering catchup-sync to pick up the new integration…')
const r = await fetch('https://comandcenter.se/api/cron/catchup-sync', {
  headers: { Authorization: `Bearer ${CRON}` },
})
console.log(`  status ${r.status}`)
const body = await r.text()
console.log('  body preview:', body.slice(0, 400))

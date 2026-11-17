// Deletes uploaded files after each shop's auto-delete time.
// Backup runner (GitHub Actions, every 6 hours). The main job is the cleanup-files Edge Function,
// called every 15 minutes by pg_cron (supabase/migrations/2026-11-17-v4-cleanup-cron.sql).
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set, skipping cleanup.')
  process.exit(0)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

let total = 0
for (let round = 0; round < 20; round++) {
  const { data, error } = await sb.rpc('cleanup_candidates')
  if (error) throw error
  if (!data?.length) break
  for (const row of data) {
    if (row.paths?.length) {
      const { error: rmErr } = await sb.storage.from('uploads').remove(row.paths)
      if (rmErr) { console.error('remove failed', row.order_id, rmErr.message); continue }
    }
    const patch = { files_deleted: true }
    if (row.status === 'uploading') patch.status = 'cancelled'
    const { error: upErr } = await sb.from('orders').update(patch).eq('id', row.order_id)
    if (upErr) console.error('update failed', row.order_id, upErr.message)
    else total++
  }
}
console.log(`Cleanup done: ${total} orders' files deleted.`)

// Deletes uploaded files after each shop's auto-delete time (same logic as scripts/cleanup.mjs).
// Called every 15 minutes by pg_cron + pg_net (supabase/migrations/2026-11-17-v4-cleanup-cron.sql).
// Deployed with --no-verify-jwt; the caller must send the x-cron-token header that the
// migration generated and keeps in private.cron_tokens (checked via public.check_cron_token).
// Env (auto-provided by the Edge Runtime): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const URL_ = Deno.env.get('SUPABASE_URL') || ''
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${URL_}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`)
  return text ? JSON.parse(text) : null
}

type Row = { order_id: string; status: string; paths: string[] | null }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  if (!URL_ || !KEY) return reply(500, { error: 'missing_env' })

  const token = req.headers.get('x-cron-token') || ''
  try {
    const ok = token ? await call('/rest/v1/rpc/check_cron_token', { method: 'POST', body: JSON.stringify({ p_name: 'cleanup', p_token: token }) }) : false
    if (ok !== true) return reply(401, { error: 'unauthorized' })
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'token_check_failed' })
  }

  let total = 0
  let failed = 0
  try {
    for (let round = 0; round < 20; round++) {
      const rows = (await call('/rest/v1/rpc/cleanup_candidates', { method: 'POST', body: '{}' })) as Row[]
      if (!rows?.length) break
      let progressed = 0
      for (const row of rows) {
        try {
          // v24: photos may have a small '<path>.thumb.jpg' beside them (missing ones are ignored)
          const paths = (row.paths || []).filter(Boolean).flatMap((p) => [p, p + '.thumb.jpg'])
          if (paths.length) {
            await call('/storage/v1/object/uploads', { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) })
          }
          const patch: Record<string, unknown> = { files_deleted: true }
          if (row.status === 'uploading') patch.status = 'cancelled'
          await call(`/rest/v1/orders?id=eq.${encodeURIComponent(row.order_id)}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
            headers: { Prefer: 'return=minimal' }
          })
          total++
          progressed++
        } catch (e) {
          failed++
          console.error('cleanup failed for order', row.order_id, e)
        }
      }
      if (!progressed) break // every row failed; stop instead of looping on the same rows
    }
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'cleanup_failed', deleted: total, failed })
  }
  console.log(`Cleanup done: ${total} orders' files deleted, ${failed} failed.`)
  return reply(200, { ok: true, deleted: total, failed })
})

// POST { order_id, key }  (no JWT: customers are not signed in; the order's access key is the proof)
// "Print again" (v23): public.reorder() has made a new order in 'uploading' whose files point at the earlier
// order's objects (order_files.source_path). This copies each object to the new order's own path with the
// service role, then reorder_finalize() checks the copies and queues the order ('received' -> new-order push).
// Every order keeps its own objects, so auto-delete of one order never removes another order's files.
import { corsHeaders, db, fail, HttpError, json } from '../_shared/billing.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type FileRow = { storage_path: string; source_path: string | null; size_bytes: number | null }

const base = () => Deno.env.get('SUPABASE_URL')!
const headers = () => {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
}
const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/')

/** Size of a stored object (from a 1-byte Range read, as finalize-order does), -1 when unknown, null when missing. */
async function storedSize(path: string): Promise<number | null> {
  const r = await fetch(`${base()}/storage/v1/object/uploads/${enc(path)}`, { headers: { ...headers(), Range: 'bytes=0-0' } })
  await r.body?.cancel()
  if (!r.ok) return null
  const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '')
  return m ? Number(m[1]) : -1
}

async function copy(from: string, to: string, size: number | null) {
  const r = await fetch(`${base()}/storage/v1/object/copy`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ bucketId: 'uploads', sourceKey: from, destinationKey: to })
  })
  if (r.ok) {
    await r.body?.cancel()
    return
  }
  const text = await r.text()
  // A retry after a half-done run: the copy is already there (customers cannot upload to these paths).
  const have = await storedSize(to)
  if (have !== null && (have === -1 || size === null || have === size)) return
  console.error('copy failed', r.status, text.slice(0, 300))
  throw new HttpError(409, 'files_gone', 'The files of this order are already deleted. Please send them again.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const b = (await req.json().catch(() => ({}))) as { order_id?: unknown; key?: unknown }
    const id = typeof b.order_id === 'string' ? b.order_id : ''
    const key = typeof b.key === 'string' ? b.key : ''
    if (!UUID.test(id) || !UUID.test(key)) throw new HttpError(404, 'not_found', 'Order not found')

    const orders = await db<{ id: string; shop_id: string }[]>(
      `orders?id=eq.${id}&access_key=eq.${key}&status=eq.uploading&select=id,shop_id`)
    const o = orders[0]
    if (!o) throw new HttpError(404, 'not_found', 'Order not found')

    const files = await db<FileRow[]>(`order_files?order_id=eq.${id}&select=storage_path,source_path,size_bytes`)
    if (!files.length || files.some((f) => !f.source_path)) throw new HttpError(404, 'not_found', 'Order not found')
    for (const f of files) {
      // Both paths must be inside this shop's folder (reorder() only ever copies within one shop).
      const src = f.source_path!
      if (!src.startsWith(o.shop_id + '/') || !f.storage_path.startsWith(o.shop_id + '/' + o.id + '/')) {
        throw new HttpError(404, 'not_found', 'Order not found')
      }
      await copy(src, f.storage_path, f.size_bytes)
    }

    const res = await fetch(`${base()}/rest/v1/rpc/reorder_finalize`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ p_order_id: id, p_key: key })
    })
    const text = await res.text()
    if (!res.ok && (res.status === 404 || text.includes('PGRST202'))) {
      console.error('reorder_finalize missing: run supabase/migrations/2026-11-21-v23-idcard-reorder-paper.sql')
      throw new HttpError(503, 'unavailable', 'Orders are temporarily unavailable. Please try again shortly.')
    }
    if (!res.ok) {
      let message = 'Could not send the order. Please try again.'
      try { message = (JSON.parse(text) as { message?: string }).message || message } catch { /* keep */ }
      throw new HttpError(400, 'finalize_failed', message)
    }
    return json({ ok: true, total: Number(JSON.parse(text)) })
  } catch (e) {
    return fail(e)
  }
})

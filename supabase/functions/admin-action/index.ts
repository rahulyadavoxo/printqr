// POST { action, ... }  (JWT required; caller must be in public.admins)
// Admin actions that need the service role or Razorpay:
//   disable_user { user_id } / enable_user { user_id }   -> Supabase Auth ban on/off
//   send_reset   { user_id }                             -> password reset email
//   cancel_subscription { shop_id }                      -> Razorpay cancel (at cycle end when possible)
//   delete_files { order_id }                            -> delete an order's files from storage now
// Every action is written to public.admin_log.
import { corsHeaders, db, fail, HttpError, json, rzp, Subscription, updateShop } from '../_shared/billing.ts'

const URL_ = Deno.env.get('SUPABASE_URL') || ''
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const SITE = 'https://print.receipto.in/'

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${URL_}${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`)
  return text ? JSON.parse(text) : null
}

async function adminId(req: Request): Promise<string> {
  const auth = req.headers.get('Authorization') || ''
  if (!auth.toLowerCase().startsWith('bearer ')) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const res = await fetch(`${URL_}/auth/v1/user`, { headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') || KEY, Authorization: auth } })
  if (!res.ok) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const user = (await res.json()) as { id?: string }
  if (!user.id) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const rows = await db<{ user_id: string }[]>(`admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`)
  if (!rows.length) throw new HttpError(403, 'not_allowed', 'not allowed')
  return user.id
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, 'bad_request', `Missing ${name}`)
  return v
}

async function log(admin: string, action: string, shop: string | null, detail: Record<string, unknown>) {
  await db('admin_log', { method: 'POST', body: JSON.stringify({ admin_id: admin, action, shop_id: shop, detail }), prefer: 'return=minimal' })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    if (!URL_ || !KEY) throw new HttpError(500, 'missing_env')
    const admin = await adminId(req)
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || '')

    if (action === 'disable_user' || action === 'enable_user') {
      const uid = id(body.user_id, 'user_id')
      if (uid === admin) throw new HttpError(400, 'self', 'You cannot disable your own login')
      await call(`/auth/v1/admin/users/${uid}`, {
        method: 'PUT',
        body: JSON.stringify({ ban_duration: action === 'disable_user' ? '876000h' : 'none' })
      })
      const shop = await db<{ id: string }[]>(`shops?owner_id=eq.${uid}&select=id`)
      await log(admin, action === 'disable_user' ? 'user_disabled' : 'user_enabled', shop[0]?.id || null, { user_id: uid })
      return json({ ok: true })
    }

    if (action === 'send_reset') {
      const uid = id(body.user_id, 'user_id')
      const user = (await call(`/auth/v1/admin/users/${uid}`)) as { email?: string }
      if (!user.email) throw new HttpError(404, 'no_email', 'This user has no email')
      await call(`/auth/v1/recover?redirect_to=${encodeURIComponent(SITE)}`, { method: 'POST', body: JSON.stringify({ email: user.email }) })
      const shop = await db<{ id: string }[]>(`shops?owner_id=eq.${uid}&select=id`)
      await log(admin, 'reset_sent', shop[0]?.id || null, { user_id: uid })
      return json({ ok: true })
    }

    if (action === 'cancel_subscription') {
      const shopId = id(body.shop_id, 'shop_id')
      const rows = await db<{ id: string; razorpay_subscription_id: string | null }[]>(
        `shops?id=eq.${shopId}&select=id,razorpay_subscription_id`)
      const subId = rows[0]?.razorpay_subscription_id
      if (!subId) throw new HttpError(404, 'no_subscription', 'No subscription to cancel')
      const current = await rzp<Subscription>(`subscriptions/${encodeURIComponent(subId)}`)
      let status = current.status
      if (!['cancelled', 'completed', 'expired'].includes(current.status)) {
        const atCycleEnd = ['active', 'authenticated', 'pending', 'halted'].includes(current.status) && !!current.current_end
        const sub = await rzp<Subscription>(`subscriptions/${encodeURIComponent(subId)}/cancel`, 'POST', { cancel_at_cycle_end: atCycleEnd ? 1 : 0 })
        status = atCycleEnd ? 'cancelled' : sub.status || 'cancelled'
      }
      await updateShop(shopId, { subscription_status: status })
      await log(admin, 'sub_cancelled', shopId, { subscription: subId, status })
      return json({ ok: true, subscription_status: status })
    }

    if (action === 'delete_files') {
      const orderId = id(body.order_id, 'order_id')
      const orders = await db<{ id: string; shop_id: string; status: string; files_deleted: boolean }[]>(
        `orders?id=eq.${orderId}&select=id,shop_id,status,files_deleted`)
      const order = orders[0]
      if (!order) throw new HttpError(404, 'not_found', 'Order not found')
      const files = await db<{ storage_path: string }[]>(`order_files?order_id=eq.${orderId}&select=storage_path`)
      const paths = files.map((f) => f.storage_path).filter(Boolean)
      if (paths.length) await call('/storage/v1/object/uploads', { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) })
      const patch: Record<string, unknown> = { files_deleted: true }
      if (order.status === 'uploading') patch.status = 'cancelled'
      await db(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=minimal' })
      await log(admin, 'files_deleted', order.shop_id, { order_id: orderId, files: paths.length })
      return json({ ok: true, files: paths.length })
    }

    throw new HttpError(400, 'bad_action', 'Unknown action')
  } catch (e) {
    return fail(e)
  }
})

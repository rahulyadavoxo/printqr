// POST { action, ... }  (JWT required; caller must be in public.admins and, while
// app_settings.admin_mfa_required is on (v36), logged in with the 2-step code: JWT aal = 'aal2')
// Admin actions that need the service role or Razorpay:
//   disable_user { user_id } / enable_user { user_id }   -> Supabase Auth ban on/off
//   delete_user  { user_id, code }                       -> delete the login, its shop (all rows cascade), its files and logo,
//                                                           and stop its Razorpay subscription. code = a fresh 6-digit code
//                                                           from the admin's authenticator app, checked here every time.
//   make_support { user_id, code }                       -> add a login to public.admins with role 'support' (fresh
//                                                           authenticator code required, like delete_user)
//   send_reset   { user_id }                             -> password reset email
//   cancel_subscription { shop_id }                      -> Razorpay cancel (at cycle end when possible)
//   delete_files { order_id }                            -> delete an order's files from storage now
//   report_dismiss { report_id }                         -> file report (v34): nothing wrong; ends the order's hold
//   report_delete_files { report_id }                    -> file report (v34): delete the reported files (takedown)
//   push_send { segment, city?, title, body, in_app? }   -> v39: push (+ in-app notice) to all / pro / free / city shops
//   notify_shop { shop_id, kind: 'expiring'|'nudge' }    -> v39: plan-ending reminder or "we miss you" nudge to one shop
// v39 roles: 'support' admins may only use the file report actions; everything else needs role 'owner'.
// Every action is written to public.admin_log.
import { corsHeaders, db, fail, HttpError, json, rzp, Subscription, updateShop } from '../_shared/billing.ts'
import { pushReady, pushUsers } from '../_shared/fcm.ts'

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

/** v39 admin role. Before the v39 SQL has run there is no role column: every admin is an owner. */
async function adminRole(uid: string): Promise<string> {
  try {
    const rows = await db<{ role: string | null }[]>(`admins?user_id=eq.${encodeURIComponent(uid)}&select=role`)
    return rows[0]?.role || 'owner'
  } catch {
    return 'owner'
  }
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
  // Same rule as is_admin() in SQL (v36): no 6-digit code in this session -> no admin actions.
  if (jwtAal(auth) !== 'aal2' && (await mfaRequired())) {
    throw new HttpError(403, 'mfa_required', 'mfa_required')
  }
  return user.id
}

// The JWT was just verified by /auth/v1/user above, so reading its payload here is safe.
function jwtAal(auth: string): string {
  try {
    const part = auth.slice(7).trim().split('.')[1] || ''
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(atob(b64)) as { aal?: string }
    return payload.aal || 'aal1'
  } catch {
    return 'aal1'
  }
}

async function mfaRequired(): Promise<boolean> {
  const rows = await db<{ admin_mfa_required: boolean | null }[]>('app_settings?id=eq.1&select=admin_mfa_required')
  return rows[0]?.admin_mfa_required !== false
}

/** Checks a fresh 6-digit code from the calling admin's authenticator app (their verified TOTP factor).
 *  Used for actions that cannot be undone, even when the session is already aal2. */
async function checkCode(req: Request, code: unknown): Promise<void> {
  const c = String(code || '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) throw new HttpError(400, 'bad_code', 'Type the 6-digit code from your authenticator app')
  const auth = req.headers.get('Authorization') || ''
  const anon = Deno.env.get('SUPABASE_ANON_KEY') || KEY
  const h = { apikey: anon, Authorization: auth, 'Content-Type': 'application/json' }
  const u = await fetch(`${URL_}/auth/v1/user`, { headers: h })
  if (!u.ok) throw new HttpError(401, 'not_logged_in', 'Please log in again')
  const user = (await u.json()) as { factors?: { id: string; factor_type: string; status: string }[] }
  const f = (user.factors || []).find((x) => x.factor_type === 'totp' && x.status === 'verified')
  if (!f) throw new HttpError(403, 'no_authenticator', 'Set up 2-step login (authenticator app) for your admin login first')
  const ch = await fetch(`${URL_}/auth/v1/factors/${f.id}/challenge`, { method: 'POST', headers: h, body: '{}' })
  if (!ch.ok) throw new HttpError(502, 'code_check_failed', `Could not check the code (${ch.status})`)
  const challenge = (await ch.json()) as { id?: string }
  const v = await fetch(`${URL_}/auth/v1/factors/${f.id}/verify`, { method: 'POST', headers: h, body: JSON.stringify({ challenge_id: challenge.id, code: c }) })
  if (!v.ok) throw new HttpError(403, 'bad_code', 'Wrong or expired code. Type the new code from the app.')
}

/** Lists every object under a folder of a bucket (one level of sub-folders is walked too). */
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (pre: string, depth: number) => {
    for (let offset = 0; ; offset += 1000) {
      const items = (await call(`/storage/v1/object/list/${bucket}`, {
        method: 'POST', body: JSON.stringify({ prefix: pre, limit: 1000, offset })
      })) as { name: string; id: string | null }[]
      for (const it of items) {
        const path = `${pre}/${it.name}`
        if (it.id) out.push(path)
        else if (depth < 3) await walk(path, depth + 1)
      }
      if (items.length < 1000) break
    }
  }
  await walk(prefix, 0)
  return out
}

async function removeObjects(bucket: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 500) {
    await call(`/storage/v1/object/${bucket}`, { method: 'DELETE', body: JSON.stringify({ prefixes: paths.slice(i, i + 500) }) })
  }
}

// v39: actions a 'support' admin may use (file reports, like the Spam tab). Everything else is owner-only.
const SUPPORT_OK = ['report_dismiss', 'report_delete_files']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, 'bad_request', `Missing ${name}`)
  return v
}

async function log(admin: string, action: string, shop: string | null, detail: Record<string, unknown>) {
  await db('admin_log', { method: 'POST', body: JSON.stringify({ admin_id: admin, action, shop_id: shop, detail }), prefer: 'return=minimal' })
}

/** Deletes an order's files (and photo thumbnails) from storage and marks the order. Returns how many objects. */
async function removeOrderFiles(orderId: string, extra: Record<string, unknown> = {}): Promise<{ shop: string; files: number }> {
  const orders = await db<{ id: string; shop_id: string; status: string; files_deleted: boolean }[]>(
    `orders?id=eq.${orderId}&select=id,shop_id,status,files_deleted`)
  const order = orders[0]
  if (!order) throw new HttpError(404, 'not_found', 'Order not found')
  const files = await db<{ storage_path: string }[]>(`order_files?order_id=eq.${orderId}&select=storage_path`)
  const paths = files.map((f) => f.storage_path).filter(Boolean).flatMap((p) => [p, p + '.thumb.jpg'])
  if (paths.length) await call('/storage/v1/object/uploads', { method: 'DELETE', body: JSON.stringify({ prefixes: paths }) })
  const patch: Record<string, unknown> = { files_deleted: true, ...extra }
  if (order.status === 'uploading') patch.status = 'cancelled'
  await db(`orders?id=eq.${orderId}`, { method: 'PATCH', body: JSON.stringify(patch), prefer: 'return=minimal' })
  return { shop: order.shop_id, files: paths.length }
}

type FileReport = { id: number; order_id: string | null; shop_id: string | null; status: string; reason: string }
async function fileReport(v: unknown): Promise<FileReport> {
  const rid = Number(v)
  if (!Number.isInteger(rid) || rid <= 0) throw new HttpError(400, 'bad_request', 'Missing report_id')
  const rows = await db<FileReport[]>(`file_reports?id=eq.${rid}&select=id,order_id,shop_id,status,reason`)
  if (!rows[0]) throw new HttpError(404, 'not_found', 'Report not found')
  return rows[0]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  let isAdmin = false
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    if (!URL_ || !KEY) throw new HttpError(500, 'missing_env')
    const admin = await adminId(req)
    isAdmin = true
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || '')
    if (!SUPPORT_OK.includes(action) && (await adminRole(admin)) !== 'owner') throw new HttpError(403, 'not_allowed', 'not allowed')

    if (action === 'push_send') {
      const segment = String(body.segment || '')
      const city = String(body.city || '').trim().slice(0, 60)
      const title = String(body.title || '').trim().slice(0, 80)
      const text = String(body.body || '').trim().slice(0, 300)
      const inApp = body.in_app !== false
      if (!['all', 'pro', 'free', 'city'].includes(segment)) throw new HttpError(400, 'bad_request', 'Pick who gets it')
      if (segment === 'city' && city.length < 2) throw new HttpError(400, 'bad_request', 'Type a city')
      if (title.length < 2 || text.length < 2) throw new HttpError(400, 'bad_request', 'Write a title and a message')
      const targets = (await call('/rest/v1/rpc/push_segment_owners', { method: 'POST', body: JSON.stringify({ p_segment: segment, p_city: city || null }) })) as { shop_id: string; owner_id: string }[]
      if (inApp && targets.length) {
        for (let i = 0; i < targets.length; i += 500) {
          await db('shop_notices', { method: 'POST', prefer: 'return=minimal',
            body: JSON.stringify(targets.slice(i, i + 500).map((t) => ({ shop_id: t.shop_id, kind: 'admin', title, body: text, created_by: admin }))) })
        }
      }
      const r = await pushUsers(targets.map((t) => t.owner_id), () => ({ title, body: text }), { tag: `admin-${Date.now()}`, path: '/dashboard', kind: 'admin_notice' })
      await log(admin, 'push_sent', null, { segment, city: segment === 'city' ? city : null, title, shops: targets.length, devices: r.devices, sent: r.sent, in_app: inApp })
      return json({ ok: true, shops: targets.length, devices: r.devices, sent: r.sent, push_ready: pushReady() })
    }

    if (action === 'notify_shop') {
      const shopId = id(body.shop_id, 'shop_id')
      const kind = String(body.kind || '')
      if (kind !== 'expiring' && kind !== 'nudge') throw new HttpError(400, 'bad_request', 'Unknown reminder')
      const rows = await db<{ id: string; owner_id: string; plan_expires_at: string | null }[]>(`shops?id=eq.${shopId}&select=id,owner_id,plan_expires_at`)
      const s = rows[0]
      if (!s) throw new HttpError(404, 'not_found', 'Shop not found')
      const until = s.plan_expires_at ? new Date(s.plan_expires_at) : null
      const dEn = until ? until.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : ''
      const dHi = until ? until.toLocaleDateString('hi-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : ''
      await db('shop_notices', { method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify({ shop_id: shopId, kind, data: kind === 'expiring' ? { until: s.plan_expires_at } : {}, created_by: admin }) })
      const words = (l: string) => {
        const en = kind === 'expiring'
          ? { title: 'Your PrintQR plan ends soon', body: `It ends on ${dEn}. Renew in the Plan tab to keep your features.` }
          : { title: 'Customers are waiting', body: 'Show your PrintQR QR code at the counter: customers send files from their phone, no WhatsApp needed.' }
        const hi = kind === 'expiring'
          ? { title: 'आपका PrintQR प्लान जल्द खत्म होगा', body: `यह ${dHi} को खत्म होगा। सुविधाएँ चालू रखने के लिए प्लान टैब में रिन्यू करें।` }
          : { title: 'ग्राहक इंतज़ार कर रहे हैं', body: 'काउंटर पर अपना PrintQR QR कोड लगाएँ: ग्राहक फ़ोन से फ़ाइल भेजें, WhatsApp की ज़रूरत नहीं।' }
        return l === 'hi' ? hi : l === 'en' ? en : { title: `${en.title} · ${hi.title}`, body: en.body }
      }
      const r = await pushUsers([s.owner_id], words, { tag: `${kind}-${shopId}`, path: kind === 'expiring' ? '/dashboard?tab=plan' : '/dashboard', kind: `shop_${kind}` })
      await log(admin, kind === 'expiring' ? 'reminder_sent' : 'nudge_sent', shopId, { devices: r.devices, sent: r.sent })
      return json({ ok: true, devices: r.devices, sent: r.sent, push_ready: pushReady() })
    }

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

    if (action === 'delete_user') {
      const uid = id(body.user_id, 'user_id')
      if (uid === admin) throw new HttpError(400, 'self', 'You cannot delete your own login')
      const isAdm = await db<{ user_id: string }[]>(`admins?user_id=eq.${uid}&select=user_id`)
      if (isAdm.length) throw new HttpError(400, 'is_admin', 'Remove this admin first, then delete the login')
      await checkCode(req, body.code)
      const user = (await call(`/auth/v1/admin/users/${uid}`)) as { email?: string; phone?: string }
      const shops = await db<{ id: string; name: string | null; razorpay_subscription_id: string | null }[]>(
        `shops?owner_id=eq.${uid}&select=id,name,razorpay_subscription_id`)
      let files = 0
      let subscription: string | null = null
      for (const s of shops) {
        // Stop billing first: if Razorpay refuses, nothing is deleted.
        if (s.razorpay_subscription_id) {
          const cur = await rzp<Subscription>(`subscriptions/${encodeURIComponent(s.razorpay_subscription_id)}`)
          if (!['cancelled', 'completed', 'expired'].includes(cur.status)) {
            await rzp<Subscription>(`subscriptions/${encodeURIComponent(s.razorpay_subscription_id)}/cancel`, 'POST', { cancel_at_cycle_end: 0 })
          }
          subscription = s.razorpay_subscription_id
        }
        const rows = await db<{ storage_path: string }[]>(`order_files?shop_id=eq.${s.id}&select=storage_path`)
        const known = rows.map((r) => r.storage_path).filter(Boolean).flatMap((p) => [p, p + '.thumb.jpg'])
        const listed = await listAll('uploads', s.id).catch(() => [] as string[])
        const uploads = [...new Set([...known, ...listed])]
        await removeObjects('uploads', uploads)
        const logos = await listAll('shop-logos', s.id).catch(() => [] as string[])
        await removeObjects('shop-logos', logos)
        files += uploads.length + logos.length
      }
      // Deleting the login deletes the shop and every row that belongs to it (on delete cascade).
      await call(`/auth/v1/admin/users/${uid}`, { method: 'DELETE' })
      await log(admin, 'user_deleted', shops[0]?.id || null, {
        user_id: uid, email: user.email || user.phone || null, shop: shops[0]?.name || null, files, subscription
      })
      return json({ ok: true, files })
    }

    if (action === 'make_support') {
      const uid = id(body.user_id, 'user_id')
      if (uid === admin) throw new HttpError(400, 'self', 'You are already an admin')
      const isAdm = await db<{ user_id: string; role: string | null }[]>(`admins?user_id=eq.${uid}&select=user_id,role`)
      if (isAdm.length) throw new HttpError(409, 'already_admin', `This login is already an admin (${isAdm[0].role || 'owner'})`)
      await checkCode(req, body.code)
      const user = (await call(`/auth/v1/admin/users/${uid}`)) as { email?: string; phone?: string }
      await db('admins', { method: 'POST', body: JSON.stringify({ user_id: uid, role: 'support' }), prefer: 'return=minimal' })
      await log(admin, 'role_changed', null, { user_id: uid, email: user.email || user.phone || null, role: 'support', before: null })
      return json({ ok: true })
    }

    if (action === 'send_reset') {
      const uid = id(body.user_id, 'user_id')
      const user = (await call(`/auth/v1/admin/users/${uid}`)) as { email?: string }
      if (!user.email) throw new HttpError(404, 'no_email', 'This user has no email')
      // Show the admin why Supabase Auth refused (email limit, send-email hook / Gmail) instead of a plain "Something went wrong".
      const res = await fetch(`${URL_}/auth/v1/recover?redirect_to=${encodeURIComponent(SITE)}`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email })
      })
      if (!res.ok) {
        const raw = await res.text()
        console.error('recover failed', res.status, raw)
        let m = ''
        try { const j = JSON.parse(raw) as { msg?: string; message?: string; error_description?: string }; m = j.msg || j.message || j.error_description || '' } catch { /* not JSON */ }
        if (res.status === 429 || /rate limit/i.test(m)) {
          throw new HttpError(429, 'email_rate_limit', 'Too many emails right now. If you just sent one to this user, wait a minute and try again; otherwise the hourly email limit is reached (Supabase > Authentication > Rate Limits).')
        }
        if (/not authorized|smtp|sending/i.test(m)) {
          throw new HttpError(502, 'email_not_sent', `Email not sent: ${m}. Check the send-email hook (Supabase > Authentication > Hooks) and the Gmail secrets.`)
        }
        throw new HttpError(502, 'email_not_sent', `Email not sent${m ? `: ${m}` : ''} (code ${res.status})`)
      }
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
      const r = await removeOrderFiles(orderId)
      await log(admin, 'files_deleted', r.shop, { order_id: orderId, files: r.files })
      return json({ ok: true, files: r.files })
    }

    // v34 file reports. The reported order stays on hold (files kept, hidden from the shop) until one of these.
    if (action === 'report_dismiss') {
      const rep = await fileReport(body.report_id)
      if (rep.status !== 'open') throw new HttpError(409, 'already_closed', 'This report is already closed')
      const now = new Date().toISOString()
      await db(`file_reports?id=eq.${rep.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed', resolved_at: now, resolved_by: admin }), prefer: 'return=minimal' })
      let released = false
      if (rep.order_id) {
        // Another open report on the same order keeps the hold.
        const others = await db<{ id: number }[]>(`file_reports?order_id=eq.${rep.order_id}&status=eq.open&select=id`)
        if (!others.length) {
          await db(`orders?id=eq.${rep.order_id}`, { method: 'PATCH', body: JSON.stringify({ hold: false }), prefer: 'return=minimal' })
          released = true
        }
      }
      await log(admin, 'file_report_dismissed', rep.shop_id, { report: rep.id, order_id: rep.order_id, released })
      return json({ ok: true, released })
    }

    if (action === 'report_delete_files') {
      const rep = await fileReport(body.report_id)
      if (rep.status !== 'open') throw new HttpError(409, 'already_closed', 'This report is already closed')
      if (!rep.order_id) throw new HttpError(404, 'not_found', 'Order not found')
      const r = await removeOrderFiles(rep.order_id, { hold: false })
      const now = new Date().toISOString()
      // Every open report on this order is closed by the takedown.
      await db(`file_reports?order_id=eq.${rep.order_id}&status=eq.open`, {
        method: 'PATCH', body: JSON.stringify({ status: 'files_deleted', resolved_at: now, resolved_by: admin }), prefer: 'return=minimal'
      })
      await log(admin, 'file_report_files_deleted', rep.shop_id || r.shop, { report: rep.id, order_id: rep.order_id, reason: rep.reason, files: r.files })
      return json({ ok: true, files: r.files })
    }

    throw new HttpError(400, 'bad_action', 'Unknown action')
  } catch (e) {
    // Only admins reach this function's actions, so show them the real reason instead of "Something went wrong".
    if (isAdmin && !(e instanceof HttpError)) {
      console.error('admin-action', e)
      const m = (e instanceof Error ? e.message : String(e)).slice(0, 400)
      return json({ error: 'server_error', message: `Server error: ${m}` }, 500)
    }
    return fail(e)
  }
})

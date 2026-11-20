// New-order push notification for the shop owner's phones (Android app, Firebase Cloud Messaging).
// Called by the orders trigger from supabase/migrations/2026-11-20-v14-push.sql (pg_net) with the
// x-cron-token header kept in private.cron_tokens (name 'push'). Deployed with --no-verify-jwt.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto) and FCM_SERVICE_ACCOUNT (the Firebase
// service-account JSON, Project settings -> Service accounts -> Generate new private key).

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

type ServiceAccount = { project_id: string; client_email: string; private_key: string }

function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let cached: { token: string; exp: number } | null = null

async function googleToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.exp - 60 > now) return cached.token
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }))
  // A key pasted with escaped newlines ("\\n") must still work.
  const pem = sa.private_key.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`))
  const jwt = `${header}.${claims}.${b64url(sig)}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  })
  const j = await res.json()
  if (!res.ok || !j.access_token) throw new Error(`google token ${res.status}: ${JSON.stringify(j)}`)
  cached = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) }
  return cached.token
}

async function fcmSend(sa: ServiceAccount, access: string, message: Record<string, unknown>): Promise<{ ok: boolean; dead: boolean; err: string }> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  })
  if (res.ok) return { ok: true, dead: false, err: '' }
  const text = await res.text()
  const dead = res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)
  return { ok: false, dead, err: dead ? '' : `fcm ${res.status}: ${text.slice(0, 300)}` }
}

/** Customer's browsers (web push) or Android app phones (FCM, v18) that asked "tell me when it's ready" on the status page (public.order_push). */
async function sendReady(sa: ServiceAccount, orderId: string): Promise<Record<string, unknown>> {
  const rows = (await call(`/rest/v1/orders?id=eq.${orderId}&select=*`)) as
    { id: string; token: number; status: string; access_key: string; shop_id: string; lang?: string | null }[]
  const o = rows[0]
  if (!o || o.status !== 'ready') return { skipped: 'not_ready' }
  const tokens = (await call(`/rest/v1/order_push?order_id=eq.${o.id}&select=token`)) as { token: string }[]
  if (!tokens.length) return { sent: 0 }
  const shops = (await call(`/rest/v1/shops?id=eq.${o.shop_id}&select=name`)) as { name: string }[]
  const shop = shops[0]?.name || 'PrintQR'
  // v18: only the language the customer ordered in (both when unknown: older orders / apps).
  const title = o.lang === 'hi' ? `ऑर्डर #${o.token} तैयार है` : o.lang === 'en' ? `Order #${o.token} is ready` : `Order #${o.token} is ready · ऑर्डर तैयार है`
  const body = o.lang === 'hi' ? `${shop}: अपने प्रिंट ले लें` : o.lang === 'en' ? `${shop}: please collect your prints` : `${shop}: please collect your prints · अपने प्रिंट ले लें`
  const link = `https://print.receipto.in/#/o/${o.id}/${o.access_key}`
  const access = await googleToken(sa)
  let sent = 0
  let lastErr = ''
  for (const { token } of tokens) {
    const r = await fcmSend(sa, access, {
      token,
      notification: { title, body },
      // `path` opens the order's status page inside the Android app (MainActivity reads it on tap).
      data: { kind: 'ready', order_id: o.id, token: String(o.token), link, path: `/o/${o.id}/${o.access_key}`, lang: o.lang === 'hi' || o.lang === 'en' ? o.lang : '' },
      // v18: the same token may be the PrintQR Android app's (status page opened in the app).
      android: {
        priority: 'HIGH',
        notification: { channel_id: 'ready', sound: 'default', tag: `ready-${o.id}`, icon: 'ic_stat_print' }
      },
      webpush: {
        headers: { Urgency: 'high', TTL: '3600' },
        notification: { title, body, icon: 'https://print.receipto.in/icon-192.png', badge: 'https://print.receipto.in/badge-96.png', tag: `ready-${o.id}`, vibrate: [200, 100, 200] },
        fcm_options: { link }
      }
    })
    if (r.ok) sent++
    else if (r.err) lastErr = r.err
  }
  // One notification per order: forget the customer's browsers now.
  await call(`/rest/v1/order_push?order_id=eq.${o.id}`, { method: 'DELETE' }).catch(() => {})
  return { sent, ...(lastErr ? { error: lastErr } : {}) }
}

type OrderRow = { id: string; token: number; total: number; customer_name: string | null; shop_id: string; counter_id: string | null; status: string }

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  if (!URL_ || !KEY) return reply(500, { error: 'missing_env' })

  const secret = req.headers.get('x-cron-token') || ''
  try {
    const ok = secret ? await call('/rest/v1/rpc/check_cron_token', { method: 'POST', body: JSON.stringify({ p_name: 'push', p_token: secret }) }) : false
    if (ok !== true) return reply(401, { error: 'unauthorized' })
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'token_check_failed' })
  }

  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT') || ''
  if (!raw) return reply(200, { skipped: 'FCM_SERVICE_ACCOUNT not set' })
  let sa: ServiceAccount
  try {
    sa = JSON.parse(raw)
    if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('incomplete')
  } catch {
    return reply(500, { error: 'bad_service_account' })
  }

  let orderId = ''
  let kind = 'new'
  try {
    const j = await req.json()
    orderId = String(j.order_id || '')
    if (j.kind === 'ready') kind = 'ready'
  } catch { /* empty body */ }
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return reply(400, { error: 'bad_order' })

  // v17: "your order is ready" for the customer (web push from the status page), all plans.
  if (kind === 'ready') {
    try {
      return reply(200, await sendReady(sa, orderId))
    } catch (e) {
      console.error(e)
      return reply(500, { error: 'push_failed', detail: String((e as Error)?.message || e).slice(0, 400) })
    }
  }

  try {
    const orders = (await call(`/rest/v1/orders?id=eq.${orderId}&select=id,token,total,customer_name,shop_id,counter_id,status`)) as OrderRow[]
    const o = orders[0]
    if (!o || o.status !== 'received') return reply(200, { skipped: 'not_received' })
    const shops = (await call(`/rest/v1/shops?id=eq.${o.shop_id}&select=owner_id,plan,plan_expires_at`)) as
      { owner_id: string; plan: string; plan_expires_at: string | null }[]
    if (!shops[0]) return reply(200, { skipped: 'no_shop' })
    // Owner's phones, plus staff phones while the shop is on Plus (v17).
    const users = [shops[0].owner_id]
    const plus = shops[0].plan === 'plus' && !!shops[0].plan_expires_at && new Date(shops[0].plan_expires_at).getTime() > Date.now()
    if (plus) {
      const staff = (await call(`/rest/v1/shop_staff?shop_id=eq.${o.shop_id}&user_id=not.is.null&select=user_id`).catch(() => [])) as { user_id: string }[]
      for (const s of staff) if (s.user_id && !users.includes(s.user_id)) users.push(s.user_id)
    }
    // v18: each phone / browser gets its own language (push_tokens.lang). Before the v18 SQL has run the
    // column does not exist yet, so fall back to tokens only (both languages, as before).
    const inList = `owner_id=in.(${users.join(',')})`
    const tokens = (await call(`/rest/v1/push_tokens?${inList}&select=token,lang`)
      .catch(() => call(`/rest/v1/push_tokens?${inList}&select=token`))) as { token: string; lang?: string | null }[]
    if (!tokens.length) return reply(200, { sent: 0 })

    let counter = ''
    if (o.counter_id) {
      const c = (await call(`/rest/v1/counters?id=eq.${o.counter_id}&select=name`)) as { name: string }[]
      counter = c[0]?.name || ''
    }
    const amount = `₹${Number(o.total).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    // v18: only the recipient's language; both (as before) when the token has no language yet.
    const texts = (lang: string | null | undefined) => {
      const who = o.customer_name || (lang === 'hi' ? 'ग्राहक' : 'Customer')
      const title = lang === 'hi' ? `नया ऑर्डर #${o.token}` : lang === 'en' ? `New order #${o.token}` : `New order #${o.token} · नया ऑर्डर`
      return { title, body: [who, amount, counter].filter(Boolean).join(' · ') }
    }

    const access = await googleToken(sa)
    let sent = 0
    let lastErr = ''
    const dead: string[] = []
    for (const { token, lang } of tokens) {
      const { title, body } = texts(lang)
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: { order_id: o.id, token: String(o.token), lang: lang === 'hi' || lang === 'en' ? lang : '' },
            android: {
              priority: 'HIGH',
              notification: { channel_id: 'orders', sound: 'default', tag: `order-${o.id}`, icon: 'ic_stat_print' }
            },
            webpush: {
              headers: { Urgency: 'high', TTL: '3600' },
              notification: { title, body, icon: 'https://print.receipto.in/icon-192.png', badge: 'https://print.receipto.in/badge-96.png', tag: `order-${o.id}` },
              fcm_options: { link: 'https://print.receipto.in/#/dashboard' }
            }
          }
        })
      })
      if (res.ok) {
        sent++
        continue
      }
      const text = await res.text()
      if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text)) dead.push(token)
      else {
        console.error('fcm', res.status, text)
        lastErr = `fcm ${res.status}: ${text.slice(0, 300)}`
      }
    }
    for (const t of dead) {
      await call(`/rest/v1/push_tokens?token=eq.${encodeURIComponent(t)}`, { method: 'DELETE' }).catch(() => {})
    }
    return reply(200, { sent, removed: dead.length, project: sa.project_id, ...(lastErr ? { error: lastErr } : {}) })
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'push_failed', detail: String((e as Error)?.message || e).slice(0, 400), project: sa.project_id })
  }
})

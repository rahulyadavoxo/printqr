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
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
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
  try {
    orderId = String((await req.json()).order_id || '')
  } catch { /* empty body */ }
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return reply(400, { error: 'bad_order' })

  try {
    const orders = (await call(`/rest/v1/orders?id=eq.${orderId}&select=id,token,total,customer_name,shop_id,counter_id,status`)) as OrderRow[]
    const o = orders[0]
    if (!o || o.status !== 'received') return reply(200, { skipped: 'not_received' })
    const shops = (await call(`/rest/v1/shops?id=eq.${o.shop_id}&select=owner_id`)) as { owner_id: string }[]
    if (!shops[0]) return reply(200, { skipped: 'no_shop' })
    const tokens = (await call(`/rest/v1/push_tokens?owner_id=eq.${shops[0].owner_id}&select=token`)) as { token: string }[]
    if (!tokens.length) return reply(200, { sent: 0 })

    let counter = ''
    if (o.counter_id) {
      const c = (await call(`/rest/v1/counters?id=eq.${o.counter_id}&select=name`)) as { name: string }[]
      counter = c[0]?.name || ''
    }
    const amount = `₹${Number(o.total).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    const title = `New order #${o.token} · नया ऑर्डर`
    const body = [o.customer_name || 'Customer', amount, counter].filter(Boolean).join(' · ')

    const access = await googleToken(sa)
    let sent = 0
    const dead: string[] = []
    for (const { token } of tokens) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            data: { order_id: o.id, token: String(o.token) },
            android: {
              priority: 'HIGH',
              notification: { channel_id: 'orders', sound: 'default', tag: `order-${o.id}`, icon: 'ic_stat_print' }
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
      else console.error('fcm', res.status, text)
    }
    for (const t of dead) {
      await call(`/rest/v1/push_tokens?token=eq.${encodeURIComponent(t)}`, { method: 'DELETE' }).catch(() => {})
    }
    return reply(200, { sent, removed: dead.length })
  } catch (e) {
    console.error(e)
    return reply(500, { error: 'push_failed' })
  }
})

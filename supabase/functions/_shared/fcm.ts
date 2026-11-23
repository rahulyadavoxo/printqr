// v39: push notifications (Firebase Cloud Messaging) to users' phones / browsers (public.push_tokens),
// shared by admin-action (targeted push, plan reminders, nudges). Same service account as push-new-order
// (env FCM_SERVICE_ACCOUNT). Dead tokens are removed. Never prints tokens or keys.

type SA = { project_id: string; client_email: string; private_key: string }

const URL_ = Deno.env.get('SUPABASE_URL') || ''
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${URL_}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path.split('?')[0]}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

let cached: { token: string; exp: number } | null = null
async function googleToken(sa: SA): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (cached && cached.exp - 60 > now) return cached.token
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const pem = sa.private_key.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` })
  })
  const j = await res.json()
  if (!res.ok || !j.access_token) throw new Error(`google token ${res.status}`)
  cached = { token: j.access_token, exp: now + (Number(j.expires_in) || 3600) }
  return cached.token
}

export type PushText = { title: string; body: string }

/** true when FCM_SERVICE_ACCOUNT is set (otherwise pushes are skipped and only in-app notices are saved). */
export function pushReady(): boolean {
  return !!Deno.env.get('FCM_SERVICE_ACCOUNT')
}

/**
 * Sends one notification to every phone / browser of these users. text(lang) gives the words per device
 * language ('hi' | 'en' | '' = unknown). Returns how many were delivered to FCM.
 */
export async function pushUsers(userIds: string[], text: (lang: string) => PushText, opts: { tag: string; path: string; kind: string }): Promise<{ sent: number; devices: number; removed: number }> {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT')
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!raw || !ids.length) return { sent: 0, devices: 0, removed: 0 }
  const tokens: { token: string; lang?: string | null }[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const inList = `owner_id=in.(${ids.slice(i, i + 100).join(',')})`
    const rows = (await call(`/rest/v1/push_tokens?${inList}&select=token,lang`)
      .catch(() => call(`/rest/v1/push_tokens?${inList}&select=token`))) as { token: string; lang?: string | null }[]
    tokens.push(...rows)
  }
  if (!tokens.length) return { sent: 0, devices: 0, removed: 0 }
  const sa = JSON.parse(raw) as SA
  const access = await googleToken(sa)
  const link = `https://print.receipto.in${opts.path}`
  let sent = 0
  const dead: string[] = []
  const one = async ({ token, lang }: { token: string; lang?: string | null }) => {
    const l = lang === 'hi' || lang === 'en' ? lang : ''
    const { title, body } = text(l)
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token,
        notification: { title, body },
        data: { kind: opts.kind, path: opts.path, lang: l },
        android: { priority: 'HIGH', notification: { channel_id: 'orders', sound: 'default', tag: opts.tag, icon: 'ic_stat_print' } },
        webpush: {
          headers: { Urgency: 'normal', TTL: '86400' },
          notification: { title, body, icon: 'https://print.receipto.in/icon-192.png', badge: 'https://print.receipto.in/badge-96.png', tag: opts.tag },
          fcm_options: { link }
        }
      } })
    })
    if (res.ok) { sent++; return }
    const t = await res.text().catch(() => '')
    if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(t)) dead.push(token)
  }
  // 10 at a time: fast for a few hundred devices without hammering FCM
  for (let i = 0; i < tokens.length; i += 10) await Promise.all(tokens.slice(i, i + 10).map((x) => one(x).catch(() => {})))
  for (const t of dead) await call(`/rest/v1/push_tokens?token=eq.${encodeURIComponent(t)}`, { method: 'DELETE' }).catch(() => {})
  return { sent, devices: tokens.length, removed: dead.length }
}

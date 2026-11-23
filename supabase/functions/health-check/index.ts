// Health check every 15 minutes, called by pg_cron (job 'printqr-health', migration v30) with the
// x-cron-token header kept in private.cron_tokens (name 'health'). Deployed with --no-verify-jwt.
// Same checks as the "Health check" GitHub workflow. A new problem is saved in public.ops_alerts and
// sent as a push notification to every admin's phones / browsers (push_tokens of public.admins).
// Still there after 6 hours: one reminder. Fixed: one "resolved" notification.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), FCM_SERVICE_ACCOUNT (same as push-new-order).

const URL_ = Deno.env.get('SUPABASE_URL') || ''
const KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const REMIND_MS = 6 * 3600 * 1000

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${URL_}${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

// bad: true = problem, false = fine, null = keep the current state (no change)
type Check = { key: string; bad: boolean | null; title: string; detail: string }
type Alert = { id: number; key: string; title: string; notified_at: string | null }
type Health = {
  events: { source: string; level: string; n: number; last: string }[]
  cron_failed: number; storage_bytes: number; db_bytes: number; cleanup_overdue: number; stuck_uploading: number
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return (await call(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) })) as T
}

async function checks(): Promise<Check[]> {
  const out: Check[] = []
  // Website
  let code = 0
  let okSite = false
  try {
    const res = await fetch('https://print.receipto.in/', { signal: AbortSignal.timeout(20000) })
    code = res.status
    okSite = res.ok && (await res.text()).includes('id="root"')
  } catch { /* down */ }
  out.push({ key: 'website', bad: !okSite, title: 'Website down', detail: `print.receipto.in answered HTTP ${code || 'no answer'}. Check GitHub Pages and the receipto.in DNS.` })

  const h = await rpc<Health>('ops_health', { p_since_min: 20 })
  const errs = h.events.filter((e) => e.level === 'error')
  const nErr = errs.reduce((s, e) => s + Number(e.n || 0), 0)
  let errBad: boolean | null = nErr > 0
  if (!errBad) {
    // Close the error alert only after 3 quiet hours (same as the GitHub workflow).
    const calm = await rpc<Health>('ops_health', { p_since_min: 180 })
    errBad = calm.events.some((e) => e.level === 'error') ? null : false
  }
  out.push({
    key: 'edge_errors', bad: errBad, title: 'Errors in Edge Functions',
    detail: errs.map((e) => `${e.source} (${e.n}x): ${e.last}`).join(' | ').slice(0, 500) || 'Errors in the last 3 hours.'
  })
  out.push({ key: 'cron', bad: h.cron_failed > 0, title: 'Scheduled jobs failing', detail: `${h.cron_failed} pg_cron run(s) failed in the last 20 minutes.` })
  out.push({
    key: 'cleanup', bad: h.cleanup_overdue > 0 || h.stuck_uploading > 0, title: 'Auto-delete is behind',
    detail: `${h.cleanup_overdue} order(s) kept files 2+ hours too long, ${h.stuck_uploading} unfinished upload(s) older than 2 hours.`
  })

  const s = ((await call('/rest/v1/app_settings?id=eq.1&select=storage_limit_mb,db_limit_mb')) as { storage_limit_mb: number; db_limit_mb: number }[])[0]
  const stMb = Math.floor(h.storage_bytes / 1048576), dbMb = Math.floor(h.db_bytes / 1048576)
  const stLim = s?.storage_limit_mb || 1024, dbLim = s?.db_limit_mb || 500
  const stP = Math.floor((stMb * 100) / stLim), dbP = Math.floor((dbMb * 100) / dbLim)
  out.push({ key: 'storage', bad: stP >= 70, title: 'Storage almost full', detail: `File storage ${stMb} MB of ${stLim} MB (${stP}%). New uploads stop at the limit.` })
  out.push({ key: 'database', bad: dbP >= 70, title: 'Database almost full', detail: `Database ${dbMb} MB of ${dbLim} MB (${dbP}%). At the limit it becomes read-only.` })
  return out
}

// ---------- push to admins (FCM, same service account as push-new-order) ----------
type SA = { project_id: string; client_email: string; private_key: string }
function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function googleToken(sa: SA): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
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
  return j.access_token
}

async function pushAdmins(title: string, body: string, tag: string): Promise<number> {
  const raw = Deno.env.get('FCM_SERVICE_ACCOUNT')
  if (!raw) return 0
  const admins = (await call('/rest/v1/admins?select=user_id')) as { user_id: string }[]
  if (!admins.length) return 0
  const tokens = (await call(`/rest/v1/push_tokens?owner_id=in.(${admins.map((a) => a.user_id).join(',')})&select=token`)) as { token: string }[]
  if (!tokens.length) return 0
  const sa = JSON.parse(raw) as SA
  const access = await googleToken(sa)
  let sent = 0
  for (const { token } of tokens) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token,
        notification: { title, body },
        data: { kind: 'admin_alert', path: '/admin' },
        android: { priority: 'HIGH', notification: { channel_id: 'orders', sound: 'default', tag, icon: 'ic_stat_print' } },
        webpush: {
          headers: { Urgency: 'high', TTL: '3600' },
          notification: { title, body, icon: 'https://print.receipto.in/icon-192.png', badge: 'https://print.receipto.in/badge-96.png', tag },
          fcm_options: { link: 'https://print.receipto.in/admin' }
        }
      } })
    })
    if (res.ok) sent++
    else await res.text().catch(() => '')
  }
  return sent
}

Deno.serve(async (req) => {
  const token = req.headers.get('x-cron-token') || ''
  const ok = await rpc<boolean>('check_cron_token', { p_name: 'health', p_token: token }).catch(() => false)
  if (!ok) return reply(401, { error: 'unauthorized' })
  try {
    const list = await checks()
    const open = (await call('/rest/v1/ops_alerts?closed_at=is.null&select=id,key,title,notified_at')) as Alert[]
    const now = new Date()
    const results: string[] = []
    for (const c of list) {
      const cur = open.find((a) => a.key === c.key)
      if (c.bad === null) { if (cur) await call(`/rest/v1/ops_alerts?id=eq.${cur.id}`, { method: 'PATCH', body: JSON.stringify({ last_seen: now }) }); continue }
      if (c.bad && !cur) {
        const sent = await pushAdmins(`PrintQR alert: ${c.title}`, c.detail, `alert-${c.key}`).catch(() => 0)
        await call('/rest/v1/ops_alerts', { method: 'POST', body: JSON.stringify({ key: c.key, title: c.title, detail: c.detail, notified_at: sent ? now : null }) })
        results.push(`open ${c.key} (push ${sent})`)
      } else if (c.bad && cur) {
        const patch: Record<string, unknown> = { last_seen: now, detail: c.detail }
        if (!cur.notified_at || now.getTime() - new Date(cur.notified_at).getTime() > REMIND_MS) {
          const sent = await pushAdmins(`PrintQR alert: ${c.title} (still)`, c.detail, `alert-${c.key}`).catch(() => 0)
          if (sent) patch.notified_at = now
        }
        await call(`/rest/v1/ops_alerts?id=eq.${cur.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      } else if (!c.bad && cur) {
        await call(`/rest/v1/ops_alerts?id=eq.${cur.id}`, { method: 'PATCH', body: JSON.stringify({ closed_at: now }) })
        if (cur.notified_at) await pushAdmins(`PrintQR: ${c.title} fixed`, 'Back to normal.', `alert-${c.key}`).catch(() => 0)
        results.push(`closed ${c.key}`)
      }
    }
    if (open.some((a) => a.key === 'health_check')) {
      await call('/rest/v1/ops_alerts?key=eq.health_check&closed_at=is.null', { method: 'PATCH', body: JSON.stringify({ closed_at: now }) })
    }
    await call('/rest/v1/app_settings?id=eq.1', { method: 'PATCH', body: JSON.stringify({ health_checked_at: now }) })
    return reply(200, { ok: true, problems: list.filter((c) => c.bad).map((c) => c.key), changes: results })
  } catch (e) {
    console.error(e)
    // One notification per outage: only when the 'health_check' alert could be opened now (not already open).
    // If Supabase itself is down this fails too; the GitHub workflow is the backup for that case.
    const msg = String((e as Error)?.message || e).slice(0, 200)
    let sent = 0
    try {
      await call('/rest/v1/ops_alerts', { method: 'POST', body: JSON.stringify({ key: 'health_check', title: 'Health check failed', detail: msg }) })
      sent = await pushAdmins('PrintQR alert: health check failed', msg, 'alert-health').catch(() => 0)
    } catch { /* already open, or the database is unreachable */ }
    return reply(500, { error: 'health_failed', push: sent })
  }
})

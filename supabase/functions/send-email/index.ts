// Supabase Auth "Send Email" hook: every Auth email (signup confirm, password reset, magic link,
// email change, invite, reauthentication) is sent from your own Gmail through the Gmail API,
// the same way Receipto does it (server/utils/mailer.js). No SMTP, no app password.
//
// Secrets (Supabase -> Edge Functions -> Secrets), same values as Receipto's Render env:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER
//   SEND_EMAIL_HOOK_SECRET  = the secret Supabase shows when you create the hook (v1,whsec_...)
// Optional: MAIL_FROM_NAME (default "PrintQR")
// Deployed with --no-verify-jwt; every request is checked with the Standard Webhooks signature instead.

import { button, esc, layout, sendGmail } from '../_shared/gmail.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''

type Hook = {
  user: { email?: string; new_email?: string; email_new?: string; user_metadata?: Record<string, unknown> }
  email_data: {
    token?: string; token_hash?: string; redirect_to?: string; email_action_type: string; site_url?: string
    token_new?: string; token_hash_new?: string
  }
}

const enc = new TextEncoder()

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}
function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

// Standard Webhooks check (what Supabase Auth hooks use).
async function verify(req: Request, body: string): Promise<void> {
  const secret = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') || '').replace(/^v1,/, '').replace(/^whsec_/, '')
  if (!secret) throw new Error('SEND_EMAIL_HOOK_SECRET is not set')
  const id = req.headers.get('webhook-id') || ''
  const ts = req.headers.get('webhook-timestamp') || ''
  const sigs = req.headers.get('webhook-signature') || ''
  if (!id || !ts || !sigs) throw new Error('missing signature headers')
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new Error('old timestamp')
  const key = await crypto.subtle.importKey('raw', b64ToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = bytesToB64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${ts}.${body}`))))
  const ok = sigs.split(' ').some((p) => {
    const v = p.split(',')[1] || ''
    if (v.length !== mac.length) return false
    let d = 0
    for (let i = 0; i < v.length; i++) d |= v.charCodeAt(i) ^ mac.charCodeAt(i)
    return d === 0
  })
  if (!ok) throw new Error('bad signature')
}

/* ---------------- Email content ---------------- */

const COPY: Record<string, { subject: string; title: string; line: string; button: string }> = {
  signup: { subject: 'Your PrintQR signup code', title: 'Confirm your email', line: 'Enter this code in PrintQR to finish creating your account, or tap the button. / अकाउंट बनाने के लिए यह कोड PrintQR में डालें, या बटन दबाएँ।', button: 'Confirm email' },
  recovery: { subject: 'Reset your PrintQR password', title: 'Reset your password', line: 'Tap the button to set a new password. If you did not ask for this, ignore this email. / नया पासवर्ड बनाने के लिए बटन दबाएँ।', button: 'Set new password' },
  magiclink: { subject: 'Your PrintQR login link', title: 'Log in to PrintQR', line: 'Tap the button to log in. / लॉग इन करने के लिए बटन दबाएँ।', button: 'Log in' },
  invite: { subject: 'You are invited to PrintQR', title: 'You are invited', line: 'Tap the button to accept the invite and set your password. / इनवाइट मानने के लिए बटन दबाएँ।', button: 'Accept invite' },
  email_change: { subject: 'Confirm your new email for PrintQR', title: 'Confirm email change', line: 'Tap the button to confirm this email change. / ईमेल बदलने की पुष्टि के लिए बटन दबाएँ।', button: 'Confirm change' },
  reauthentication: { subject: 'Your PrintQR confirmation code', title: 'Confirmation code', line: 'Use this code to confirm it is you. / पुष्टि के लिए यह कोड डालें।', button: '' }
}

function link(type: string, hash: string, redirect: string): string {
  const u = new URL(`${SUPABASE_URL}/auth/v1/verify`)
  u.searchParams.set('token', hash)
  u.searchParams.set('type', type)
  if (redirect) u.searchParams.set('redirect_to', redirect)
  return u.toString()
}

function render(type: string, url: string | null, code: string | undefined) {
  const c = COPY[type] || COPY.magiclink
  const otp = code ? `<p style="font-size:14px;color:#334155">${type === 'signup' ? 'Your code / आपका कोड' : 'Code'}:</p>
<p style="font-size:30px;font-weight:800;letter-spacing:6px;color:#0f172a;margin:6px 0 18px">${esc(code)}</p>` : ''
  const link = url ? `${button(url, c.button)}
<p style="font-size:12px;color:#64748b">If the button does not work, open this link:<br><a href="${esc(url)}" style="color:#4d7c0f;word-break:break-all">${esc(url)}</a></p>` : ''
  const html = layout(c.title, `<p style="color:#334155;line-height:1.5">${esc(c.line)}</p>${otp}${link}`)
  const text = `${c.title}\n\n${c.line}\n\n${code ? `Code: ${code}\n` : ''}${url ? `${c.button}: ${url}\n` : ''}\nPrintQR · print.receipto.in`
  return { subject: c.subject, html, text }
}

function hookError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return hookError(405, 'method not allowed')
  const body = await req.text()
  try {
    await verify(req, body)
  } catch (e) {
    console.error('hook signature', e)
    return hookError(401, 'invalid signature')
  }
  try {
    const { user, email_data: d } = JSON.parse(body) as Hook
    const type = d.email_action_type
    const redirect = d.redirect_to || d.site_url || ''
    const jobs: { to: string; hash?: string; code?: string }[] = []
    if (type === 'email_change') {
      // Supabase quirk: token_hash_new goes with the CURRENT email, token_hash with the NEW one.
      const newEmail = user.new_email || user.email_new || ''
      if (user.email && d.token_hash_new) jobs.push({ to: user.email, hash: d.token_hash_new, code: d.token_new })
      if (newEmail && d.token_hash) jobs.push({ to: newEmail, hash: d.token_hash, code: d.token })
      if (!jobs.length && user.email && d.token_hash) jobs.push({ to: user.email, hash: d.token_hash, code: d.token })
    } else if (type === 'reauthentication') {
      if (user.email) jobs.push({ to: user.email, code: d.token })
    } else if (user.email) {
      jobs.push({ to: user.email, hash: d.token_hash, code: type === 'signup' ? d.token : undefined })
    }
    if (!jobs.length) return hookError(400, 'no recipient')
    for (const j of jobs) {
      const url = j.hash ? link(type, j.hash, redirect) : null
      const m = render(type, url, j.code)
      await sendGmail(j.to, m.subject, m.html, m.text)
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('send-email', e)
    return hookError(500, e instanceof Error ? e.message : 'send failed')
  }
})

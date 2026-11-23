// Supabase Auth "Send Email" hook: every Auth email (signup confirm, password reset, magic link,
// email change, invite, reauthentication) is sent from your own Gmail through the Gmail API,
// the same way Receipto does it (server/utils/mailer.js). No SMTP, no app password.
//
// Secrets (Supabase -> Edge Functions -> Secrets), same values as Receipto's Render env:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER
//   SEND_EMAIL_HOOK_SECRET  = the secret Supabase shows when you create the hook (v1,whsec_...)
// Optional: MAIL_FROM_NAME (default "PrintQR")
// Deployed with --no-verify-jwt; every request is checked with the Standard Webhooks signature instead.

import type { MailIcon } from '../_shared/gmail.ts'
import { button, codeBox, fallbackLink, layout, note, para, sendMail } from '../_shared/gmail.ts'
import { logOps } from '../_shared/ops.ts'

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

type Copy = { subject: string; icon: MailIcon; title: string; subtitle: string; line: string; lineHi: string; button: string; codeLabel: string; preheader: string; safety: string }

const SAFETY = 'Ye aapne nahi maanga tha? To is mail ko ignore kar dein, aapka account safe hai. / If this was not you, ignore this email.'

const COPY: Record<string, Copy> = {
  signup: {
    subject: 'Your PrintQR code', icon: 'mail', title: 'Confirm your email', subtitle: 'अपना ईमेल कन्फ़र्म करें',
    line: 'Bas ek step aur! Ye code PrintQR mein daalein ya neeche button dabayein, aapka shop account ready ho jayega.',
    lineHi: 'नीचे दिया कोड PrintQR में डालें या बटन दबाएँ।',
    button: 'Confirm email', codeLabel: 'Your code · आपका कोड', preheader: 'Your PrintQR signup code is inside', safety: SAFETY
  },
  recovery: {
    subject: 'Reset your PrintQR password', icon: 'key', title: 'Reset your password', subtitle: 'नया पासवर्ड बनाएँ',
    line: 'Password bhool gaye? Koi baat nahi. Neeche button dabake naya password set kar lijiye.',
    lineHi: 'नया पासवर्ड बनाने के लिए बटन दबाएँ।',
    button: 'Set new password', codeLabel: 'Code', preheader: 'Tap to set a new PrintQR password', safety: SAFETY
  },
  magiclink: {
    subject: 'Your PrintQR login link', icon: 'magic', title: 'Log in to PrintQR', subtitle: 'PrintQR में लॉग इन करें',
    line: 'Ek tap mein login karein, password ki zaroorat nahi.',
    lineHi: 'लॉग इन करने के लिए बटन दबाएँ।',
    button: 'Log in', codeLabel: 'Code', preheader: 'Your one-tap login link', safety: SAFETY
  },
  invite: {
    subject: 'You are invited to PrintQR', icon: 'ticket', title: 'You are invited', subtitle: 'आपको PrintQR पर बुलाया गया है',
    line: 'Aapko PrintQR par invite kiya gaya hai. Button dabake invite accept karein aur apna password banayein.',
    lineHi: 'इनवाइट स्वीकार करने के लिए बटन दबाएँ।',
    button: 'Accept invite', codeLabel: 'Code', preheader: 'Accept your PrintQR invite', safety: 'Aap is invite ko nahi jaante? To ignore kar dein. / Not expecting this? Ignore it.'
  },
  email_change: {
    subject: 'Confirm your new email for PrintQR', icon: 'mail', title: 'Confirm email change', subtitle: 'ईमेल बदलने की पुष्टि करें',
    line: 'Aapke PrintQR account ka email badla ja raha hai. Pakka karne ke liye button dabayein.',
    lineHi: 'ईमेल बदलने की पुष्टि के लिए बटन दबाएँ।',
    button: 'Confirm change', codeLabel: 'Code', preheader: 'Confirm your new PrintQR email', safety: 'Ye badlaav aapne nahi kiya? To turant apna password badlein. / Not you? Change your password now.'
  },
  reauthentication: {
    subject: 'Your PrintQR confirmation code', icon: 'shield', title: 'Confirmation code', subtitle: 'पुष्टि कोड',
    line: 'Ye aap hi hain, ye pakka karne ke liye ye code daalein.',
    lineHi: 'पुष्टि के लिए यह कोड डालें।',
    button: '', codeLabel: 'Your code · आपका कोड', preheader: 'Your PrintQR confirmation code', safety: SAFETY
  }
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
  const body = [
    para(c.line),
    para(c.lineHi, true),
    code ? codeBox(code, c.codeLabel) : '',
    url && c.button ? button(url, c.button) : '',
    url && c.button ? fallbackLink(url) : '',
    note(c.safety)
  ].join('\n')
  const html = layout(c.title, body, { icon: c.icon, subtitle: c.subtitle, preheader: code ? `${c.preheader}: ${code}` : c.preheader })
  const text = `${c.title}\n\n${c.line}\n${c.lineHi}\n\n${code ? `Code: ${code}\n` : ''}${url && c.button ? `${c.button}: ${url}\n` : ''}\n${c.safety}\n\nPrintQR · print.receipto.in`
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
      await sendMail(j.to, m.subject, m.html, m.text)
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    console.error('send-email', e)
    await logOps('send-email', e)
    return hookError(500, e instanceof Error ? e.message : 'send failed')
  }
})

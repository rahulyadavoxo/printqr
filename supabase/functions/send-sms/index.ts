// Supabase Auth "Send SMS" hook: the login / signup OTP for mobile numbers is sent as a normal SMS from
// a spare Android phone running "SMS Gateway for Android" (SMSGate, https://docs.sms-gate.app), cloud mode.
// No DLT / SMS company needed; the SIM's own SMS pack pays for it.
//
// Secrets (Supabase -> Edge Functions -> Secrets):
//   SMSGATE_USERNAME, SMSGATE_PASSWORD  = shown in the SMSGate app (Home -> Cloud server) after "Start"
//   SEND_SMS_HOOK_SECRET                = the secret Supabase shows when you create the hook (v1,whsec_...)
// Optional: SMSGATE_URL (default https://api.sms-gate.app/3rdparty/v1/messages, change it for a private server)
//           SMS_APP_HASH = Android app hash(es) for automatic OTP reading in the app (see text.ts)
// Deployed with --no-verify-jwt; every request is checked with the Standard Webhooks signature instead.
//
// Only Indian mobile numbers (+91, 10 digits starting 6-9) get an SMS. The OTP is never logged.

import { logOps } from '../_shared/ops.ts'
import { appHashes, smsText } from './text.ts'

const SMSGATE_URL = Deno.env.get('SMSGATE_URL') || 'https://api.sms-gate.app/3rdparty/v1/messages'
// Supabase gives an HTTP hook 5 seconds in total, so give up on SMSGate a little before that.
const SEND_TIMEOUT_MS = 4500
const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/

type Hook = {
  user: { id?: string; phone?: string }
  sms: { otp?: string }
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

// Standard Webhooks check (what Supabase Auth hooks use). Same as send-email.
async function verify(req: Request, body: string): Promise<void> {
  const secret = (Deno.env.get('SEND_SMS_HOOK_SECRET') || '').replace(/^v1,/, '').replace(/^whsec_/, '')
  if (!secret) throw new Error('SEND_SMS_HOOK_SECRET is not set')
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

function hookError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: { 'Content-Type': 'application/json' } })
}

/** +91XXXXXX1234: enough to find a problem in the logs, without the full number. */
function mask(phone: string): string {
  return phone.length > 7 ? `${phone.slice(0, 3)}XXXXXX${phone.slice(-4)}` : 'XXXX'
}

/** Supabase sends the number in E.164, usually without the "+" ("919876543210"). */
function normalise(raw: string): string {
  const d = String(raw || '').replace(/[^\d]/g, '')
  if (d.length === 10) return `+91${d}`
  return `+${d}`
}

// "PrintQR code: 123456. Do not share.\n<app hash>": English only (GSM-7), 47 bytes with one hash.
const text = (otp: string) => smsText(otp, appHashes(Deno.env.get('SMS_APP_HASH')))

Deno.serve(async (req) => {
  if (req.method !== 'POST') return hookError(405, 'method not allowed')
  const body = await req.text()
  try {
    await verify(req, body)
  } catch (e) {
    console.error('hook signature', e)
    return hookError(401, 'invalid signature')
  }
  let phone = ''
  try {
    const { user, sms } = JSON.parse(body) as Hook
    phone = normalise(user?.phone || '')
    const otp = String(sms?.otp || '')
    if (!INDIAN_MOBILE.test(phone)) return hookError(400, 'Only Indian mobile numbers (+91) are supported')
    if (!/^\d{4,10}$/.test(otp)) return hookError(400, 'no otp in hook payload')

    const user_ = Deno.env.get('SMSGATE_USERNAME') || ''
    const pass = Deno.env.get('SMSGATE_PASSWORD') || ''
    if (!user_ || !pass) throw new Error('SMSGATE_USERNAME / SMSGATE_PASSWORD are not set')

    let res: Response
    try {
      res = await fetch(SMSGATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${user_}:${pass}`)}` },
        body: JSON.stringify({
          textMessage: { text: text(otp) },
          phoneNumbers: [phone],
          ttl: 600, // phone offline for 10 minutes: drop it, an old code is useless by then
          priority: 100 // OTP: skip the app's own delays / limits between messages
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
      })
    } catch (e) {
      const timedOut = e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new Error(timedOut ? 'SMSGate did not answer in time' : `SMSGate not reachable: ${e instanceof Error ? e.message : e}`)
    }
    if (!res.ok) {
      // The reply never contains the message text; still keep it short.
      const raw = (await res.text().catch(() => '')).slice(0, 200)
      if (res.status === 401 || res.status === 403) throw new Error(`SMSGate login refused (${res.status}): check SMSGATE_USERNAME / SMSGATE_PASSWORD`)
      throw new Error(`SMSGate error ${res.status}: ${raw}`)
    }
    await res.body?.cancel().catch(() => undefined)
    console.log('sms queued', mask(phone))
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    const m = e instanceof Error ? e.message : 'send failed'
    console.error('send-sms', mask(phone), m)
    await logOps('send-sms', `${mask(phone)}: ${m}`)
    return hookError(500, `SMS not sent: ${m}`)
  }
})

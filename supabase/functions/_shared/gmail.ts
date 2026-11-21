// Sends PrintQR's mail. sendMail() is what the functions call:
//  1. Resend (a transactional mail service), when RESEND_API_KEY is set. From: MAIL_FROM (e.g. no-reply@receipto.in,
//     the domain must be verified in Resend).
//  2. Otherwise, or when Resend fails, your own Gmail through the Gmail API (same flow as Receipto's mailer.js).
// Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER. Optional MAIL_FROM_NAME,
//          RESEND_API_KEY, MAIL_FROM.

const FROM_NAME = Deno.env.get('MAIL_FROM_NAME') || 'PrintQR'
const enc = new TextEncoder()

function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
export const utf8B64 = (s: string) => bytesToB64(enc.encode(s))

let accessToken = ''
let accessExp = 0

async function gmailToken(): Promise<string> {
  if (accessToken && Date.now() < accessExp - 60_000) return accessToken
  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].filter((k) => !(Deno.env.get(k) || '').trim())
  if (missing.length) throw new Error(`Missing secret(s): ${missing.join(', ')}`)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: (Deno.env.get('GMAIL_CLIENT_ID') || '').trim(),
      client_secret: (Deno.env.get('GMAIL_CLIENT_SECRET') || '').trim(),
      refresh_token: (Deno.env.get('GMAIL_REFRESH_TOKEN') || '').trim()
    })
  })
  const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !data.access_token) {
    // Google's error code is safe to log (invalid_grant = token expired/revoked, invalid_client = wrong client id/secret).
    throw new Error(`Gmail token request failed (${res.status}): ${data.error || ''} ${data.error_description || ''}`.trim())
  }
  accessToken = data.access_token
  accessExp = Date.now() + (Number(data.expires_in) || 3600) * 1000
  return accessToken
}

export async function sendGmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const sender = (Deno.env.get('GMAIL_SENDER') || '').trim()
  if (!sender) throw new Error('GMAIL_SENDER is not set')
  const boundary = `pq_${crypto.randomUUID()}`
  const raw = [
    `From: =?UTF-8?B?${utf8B64(FROM_NAME)}?= <${sender}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${utf8B64(subject)}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    utf8B64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    utf8B64(html),
    `--${boundary}--`,
    ''
  ].join('\r\n')
  const rawB64url = utf8B64(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await gmailToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: rawB64url })
  })
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

async function sendResend(to: string, subject: string, html: string, text: string): Promise<void> {
  const key = (Deno.env.get('RESEND_API_KEY') || '').trim()
  const from = (Deno.env.get('MAIL_FROM') || '').trim()
  if (!from) throw new Error('MAIL_FROM is not set (needed with RESEND_API_KEY)')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${FROM_NAME} <${from}>`, to: [to], subject, html, text })
  })
  if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${(await res.text()).slice(0, 200)}`)
}

/** Resend first (when configured), Gmail as the fallback. Throws only when every way failed. */
export async function sendMail(to: string, subject: string, html: string, text: string): Promise<void> {
  if ((Deno.env.get('RESEND_API_KEY') || '').trim()) {
    try {
      return await sendResend(to, subject, html, text)
    } catch (e) {
      console.error('Resend failed, trying Gmail:', e instanceof Error ? e.message : e)
      try {
        return await sendGmail(to, subject, html, text)
      } catch (g) {
        throw new Error(`${e instanceof Error ? e.message : e} | ${g instanceof Error ? g.message : g}`)
      }
    }
  }
  return sendGmail(to, subject, html, text)
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

const SITE_URL = 'https://print.receipto.in/'
const LOGO = 'https://print.receipto.in/icon-192.png'
const INK = '#0b1210'
const LIME = '#a6e22e'
const BRAND = '#3f6212'
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

export type LayoutOpts = {
  /** Hidden one-line preview text shown in the inbox list. */
  preheader?: string
  /** Big emoji/icon above the title in the dark header. */
  icon?: string
  /** Small line under the title in the header (e.g. Hindi title). */
  subtitle?: string
}

/**
 * PrintQR mail layout: dark header band with logo, white card, lime accents, footer.
 * Table-based with inline styles so it looks right in Gmail, Outlook and phone mail apps.
 * bodyHtml is already-escaped HTML.
 */
export function layout(title: string, bodyHtml: string, opts: LayoutOpts = {}): string {
  const pre = opts.preheader ? esc(opts.preheader) : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f3f1ea;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${pre}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f1ea">
<tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">

<tr><td style="background:${INK};background-image:linear-gradient(135deg,#0b1210 0%,#1f2d16 70%,#3f6212 100%);border-radius:20px 20px 0 0;padding:26px 28px 30px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="vertical-align:middle"><img src="${LOGO}" width="40" height="40" alt="PrintQR" style="display:block;border:0;border-radius:11px"></td>
    <td style="vertical-align:middle;padding-left:12px;font-family:${FONT}">
      <div style="font-size:22px;font-weight:800;color:#ffffff;line-height:1">print</div>
      <div style="font-size:9px;font-weight:700;letter-spacing:2.5px;color:${LIME};padding-top:4px">BY RECEIPTO</div>
    </td>
  </tr></table>
  ${opts.icon ? `<div style="font-size:40px;line-height:1;padding-top:26px">${opts.icon}</div>` : ''}
  <h1 style="margin:${opts.icon ? '12px' : '26px'} 0 0;font-family:${FONT};font-size:26px;line-height:1.25;font-weight:800;color:#ffffff">${esc(title)}</h1>
  ${opts.subtitle ? `<div style="font-family:${FONT};font-size:15px;color:#c9ec8a;padding-top:6px">${esc(opts.subtitle)}</div>` : ''}
</td></tr>

<tr><td style="background:#ffffff;border-radius:0 0 20px 20px;padding:28px;font-family:${FONT};font-size:15px;line-height:1.6;color:#2f3a50">
${bodyHtml}
</td></tr>

<tr><td align="center" style="padding:22px 16px 6px;font-family:${FONT};font-size:12px;line-height:1.6;color:#8a93a3">
  <b style="color:#586274">PrintQR</b> · Scan karo, file bhejo, print lo<br>
  <a href="${SITE_URL}" style="color:${BRAND};text-decoration:none;font-weight:600">print.receipto.in</a>
</td></tr>

</table></td></tr></table></body></html>`
}

/** Big lime call-to-action button (bulletproof table button). */
export function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 8px"><tr>
<td style="background:${LIME};border-radius:12px;box-shadow:0 2px 0 #6fa012">
<a href="${esc(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:800;color:${INK};text-decoration:none;border-radius:12px">${esc(label)} &rarr;</a>
</td></tr></table>`
}

/** Paragraph. text is plain text (escaped here). */
export function para(text: string, muted = false): string {
  return `<p style="margin:0 0 14px;color:${muted ? '#586274' : '#2f3a50'};font-size:${muted ? '14px' : '15px'}">${esc(text)}</p>`
}

/** One-time code in a big dashed box. */
export function codeBox(code: string, label: string): string {
  return `<div style="margin:22px 0 6px;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#586274">${esc(label)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td align="center" style="background:#f2fbe0;border:2px dashed #93cc1f;border-radius:14px;padding:18px 10px;font-family:'SFMono-Regular',Consolas,'Courier New',monospace;font-size:34px;font-weight:800;letter-spacing:10px;color:${INK}">${esc(code)}</td>
</tr></table>`
}

/** Numbered steps, each a soft row with a lime number badge. */
export function steps(items: string[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 4px">${items.map((x, i) => `
<tr><td style="padding:6px 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f6f1;border-radius:12px"><tr>
<td width="44" style="padding:12px 0 12px 12px;vertical-align:top"><div style="width:30px;height:30px;line-height:30px;border-radius:15px;background:${LIME};color:${INK};font-weight:800;font-size:14px;text-align:center">${i + 1}</div></td>
<td style="padding:12px 14px 12px 8px;font-size:14px;line-height:1.5;color:#2f3a50">${esc(x)}</td>
</tr></table></td></tr>`).join('')}</table>`
}

/** Small note box (security / tips). */
export function note(text: string): string {
  return `<div style="margin:22px 0 0;padding:12px 14px;background:#fff6e0;border-radius:12px;font-size:13px;line-height:1.5;color:#7a4a00">${esc(text)}</div>`
}

/** Fallback link under a button. */
export function fallbackLink(url: string): string {
  return `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#8a93a3">Button kaam na kare to ye link kholein / If the button does not work:<br><a href="${esc(url)}" style="color:${BRAND};word-break:break-all">${esc(url)}</a></p>`
}

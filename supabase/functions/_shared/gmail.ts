// Send mail from your own Gmail through the Gmail API (same flow as Receipto's server/utils/mailer.js).
// Secrets: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER. Optional MAIL_FROM_NAME.

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
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: Deno.env.get('GMAIL_CLIENT_ID') || '',
      client_secret: Deno.env.get('GMAIL_CLIENT_SECRET') || '',
      refresh_token: Deno.env.get('GMAIL_REFRESH_TOKEN') || ''
    })
  })
  const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number }
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail token request failed (${res.status}). The refresh token may be expired or revoked.`)
  }
  accessToken = data.access_token
  accessExp = Date.now() + (Number(data.expires_in) || 3600) * 1000
  return accessToken
}

export async function sendGmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const sender = Deno.env.get('GMAIL_SENDER') || ''
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


export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

/** PrintQR mail layout. bodyHtml is already-escaped HTML. */
export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f5f0;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:28px 20px"><div style="background:#fff;border-radius:14px;padding:26px">
<div style="font-size:22px;font-weight:800;color:#0f172a">print <span style="font-size:11px;color:#4d7c0f;letter-spacing:2px">BY RECEIPTO</span></div>
<h2 style="color:#0f172a;margin:18px 0 8px">${esc(title)}</h2>
${bodyHtml}
</div><p style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px">PrintQR · print.receipto.in</p></div></body></html>`
}

export function button(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#84cc16;color:#0f172a;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">${esc(label)}</a></p>`
}

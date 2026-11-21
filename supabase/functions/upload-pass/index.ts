// POST { token }  (no JWT: customers are not signed in)
// Checks the Cloudflare Turnstile token with siteverify (server side), then hands back a one-time pass.
// v25: create_order(p_pass) asks for a pass only when an order looks automated (many orders from one network
// or one shop in 10 minutes), or always when app_settings.order_captcha = 'always'. Normal customers never see it.
// Env: TURNSTILE_SECRET (Supabase Edge Function secret), optional TURNSTILE_HOSTNAMES (comma list).
import { corsHeaders, db, fail, HttpError, json } from '../_shared/billing.ts'
import { logOps } from '../_shared/ops.ts'

const EXPECTED_ACTION = 'upload'

function expectedHostnames(): Set<string> {
  const raw = Deno.env.get('TURNSTILE_HOSTNAMES') || 'print.receipto.in,appassets.androidplatform.net'
  return new Set(raw.split(',').map((h) => h.trim()).filter(Boolean))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const b = (await req.json().catch(() => ({}))) as { token?: unknown }
    const token = b.token
    const hosts = expectedHostnames()
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048 || hosts.size === 0) {
      throw new HttpError(403, 'captcha_failed', 'captcha_failed')
    }
    const secret = Deno.env.get('TURNSTILE_SECRET')
    if (!secret) {
      await logOps('upload-pass', 'TURNSTILE_SECRET is not set: customers asked for the bot check cannot order')
      throw new HttpError(503, 'captcha_not_configured', 'captcha_not_configured')
    }

    const ip = req.headers.get('cf-connecting-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    const body = new URLSearchParams({ secret, response: token })
    if (ip) body.set('remoteip', ip)

    let result: { success?: boolean; action?: string; hostname?: string; 'error-codes'?: string[] }
    try {
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10_000),
        body
      })
      if (!r.ok) throw new Error(`siteverify ${r.status}`)
      result = await r.json()
    } catch {
      throw new HttpError(403, 'captcha_failed', 'captcha_failed')
    }
    // A wrong TURNSTILE_SECRET is a setup problem, not a visitor problem: say so (no secret in the reply).
    if ((result['error-codes'] || []).includes('invalid-input-secret')) {
      await logOps('upload-pass', 'TURNSTILE_SECRET is wrong (Cloudflare said invalid-input-secret)')
      throw new HttpError(503, 'captcha_secret_invalid', 'captcha_secret_invalid')
    }
    if (!result.success || result.action !== EXPECTED_ACTION || !hosts.has(result.hostname || '')) {
      throw new HttpError(403, 'captcha_failed', 'captcha_failed')
    }

    const rows = await db<{ id: string }[]>('upload_pass?select=id', {
      method: 'POST',
      body: JSON.stringify({ created_at: new Date().toISOString() }),
      prefer: 'return=representation'
    })
    return json({ pass: rows[0].id })
  } catch (e) {
    return fail(e)
  }
})

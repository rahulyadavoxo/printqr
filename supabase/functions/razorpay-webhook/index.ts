// Razorpay webhook (deployed with --no-verify-jwt).
// URL: https://<project-ref>.supabase.co/functions/v1/razorpay-webhook
// Events: subscription.activated, subscription.charged, subscription.cancelled,
//         subscription.halted, subscription.completed (others are acknowledged and ignored).
// Signature: X-Razorpay-Signature = hex HMAC-SHA256(raw body, RAZORPAY_WEBHOOK_SECRET).
import { activate, db, getShopById, hmacHex, safeEqual, Subscription, subNotes, updateShop } from '../_shared/billing.ts'

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' })
  const secret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')
  if (!secret) return reply(503, { error: 'webhook_secret_not_set' })

  const raw = new Uint8Array(await req.arrayBuffer())
  const given = (req.headers.get('x-razorpay-signature') || '').toLowerCase()
  const expected = await hmacHex(secret, raw)
  if (!given || !safeEqual(expected, given)) return reply(401, { error: 'bad_signature' })

  let evt: { event?: string; payload?: { subscription?: { entity?: Subscription } } }
  try {
    evt = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return reply(400, { error: 'bad_json' })
  }
  const event = evt.event || ''
  const sub = evt.payload?.subscription?.entity
  const eventId = req.headers.get('x-razorpay-event-id') || ''

  try {
    if (!event.startsWith('subscription.') || !sub?.id) return reply(200, { ok: true, ignored: event })
    if (sub.notes === undefined || !subNotes(sub).shop_id) return reply(200, { ok: true, ignored: 'not_printqr' })

    // Idempotency: an event id we already handled is acknowledged without doing anything.
    if (eventId) {
      const seen = await db<{ event_id: string }[]>(`billing_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id`)
      if (seen.length) return reply(200, { ok: true, duplicate: true })
    }

    if (event === 'subscription.activated' || event === 'subscription.charged' || event === 'subscription.resumed') {
      await activate(sub)
    } else if (['subscription.cancelled', 'subscription.halted', 'subscription.completed', 'subscription.paused', 'subscription.pending'].includes(event)) {
      // Status only. Pro stays until plan_expires_at (already paid for).
      const shop = await getShopById(subNotes(sub).shop_id)
      if (shop && shop.razorpay_subscription_id === sub.id) {
        await updateShop(shop.id, { subscription_status: sub.status || event.slice('subscription.'.length) })
      }
    }

    if (eventId) {
      await db('billing_events?on_conflict=event_id', {
        method: 'POST',
        body: JSON.stringify({ event_id: eventId, event }),
        prefer: 'resolution=ignore-duplicates,return=minimal'
      })
    }
    return reply(200, { ok: true })
  } catch (e) {
    console.error(e)
    // Non-2xx makes Razorpay retry later.
    return reply(500, { error: 'server_error' })
  }
})

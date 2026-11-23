// Razorpay webhook (deployed with --no-verify-jwt).
// URL: https://<project-ref>.supabase.co/functions/v1/razorpay-webhook
// Events: subscription.activated, subscription.charged, subscription.cancelled,
//         subscription.halted, subscription.completed (others are acknowledged and ignored).
// Signature: X-Razorpay-Signature = hex HMAC-SHA256(raw body, RAZORPAY_WEBHOOK_SECRET).
import { activate, db, getShopById, hmacHex, Payment, recordPayment, safeEqual, Subscription, subNotes, updateShop } from '../_shared/billing.ts'
import { logOps } from '../_shared/ops.ts'

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

  let evt: { event?: string; payload?: { subscription?: { entity?: Subscription }; payment?: { entity?: Payment } } }
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

    // Idempotency: claim the event id first (unique). A conflict means another delivery has it: skip.
    // If the work below fails, the claim is removed again so Razorpay's retry can process the event.
    let claimed = false
    if (eventId) {
      const rows = await db<{ event_id: string }[]>('billing_events?on_conflict=event_id', {
        method: 'POST',
        body: JSON.stringify({ event_id: eventId, event }),
        prefer: 'resolution=ignore-duplicates,return=representation'
      })
      if (!rows?.length) return reply(200, { ok: true, duplicate: true })
      claimed = true
    }

    try {
      if (event === 'subscription.activated' || event === 'subscription.charged' || event === 'subscription.resumed') {
        await activate(sub)
        // One receipt row per charge (v33). subscription.charged carries the payment.
        const pay = evt.payload?.payment?.entity
        if (event === 'subscription.charged' && pay?.id) await recordPayment(sub, pay)
      } else if (['subscription.cancelled', 'subscription.halted', 'subscription.completed', 'subscription.paused', 'subscription.pending'].includes(event)) {
        // Status only. The plan stays until plan_expires_at (already paid for).
        const shop = await getShopById(subNotes(sub).shop_id)
        if (shop && shop.razorpay_subscription_id === sub.id) {
          await updateShop(shop.id, { subscription_status: sub.status || event.slice('subscription.'.length) })
        }
      }
    } catch (e) {
      if (claimed) {
        await db(`billing_events?event_id=eq.${encodeURIComponent(eventId)}`, { method: 'DELETE', prefer: 'return=minimal' })
          .catch((d) => console.error('release event claim', d))
      }
      throw e
    }
    return reply(200, { ok: true })
  } catch (e) {
    console.error(e)
    await logOps('razorpay-webhook', e)
    // Non-2xx makes Razorpay retry later.
    return reply(500, { error: 'server_error' })
  }
})

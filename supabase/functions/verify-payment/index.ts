// POST { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }  (JWT required)
// Verifies the Razorpay Checkout signature, then turns Pro on from the subscription's current cycle.
import { activate, corsHeaders, fail, hmacHex, HttpError, json, keySecret, ownerShop, rzp, safeEqual, Subscription } from '../_shared/billing.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const b = (await req.json().catch(() => ({}))) as Record<string, string | undefined>
    const paymentId = b.razorpay_payment_id || ''
    const subId = b.razorpay_subscription_id || ''
    const signature = (b.razorpay_signature || '').toLowerCase()
    if (!paymentId || !subId || !signature) throw new HttpError(400, 'missing_fields', 'Payment details missing')

    const { shop } = await ownerShop(req)
    const expected = await hmacHex(keySecret(), `${paymentId}|${subId}`)
    if (!safeEqual(expected, signature)) throw new HttpError(400, 'bad_signature', 'Payment could not be verified')

    const sub = await rzp<Subscription>(`subscriptions/${encodeURIComponent(subId)}`)
    // A replayed checkout of a subscription that has ended must not switch the plan back on.
    if (['cancelled', 'completed', 'expired', 'halted'].includes(String(sub.status || ''))) {
      throw new HttpError(409, 'subscription_ended', 'This subscription has ended. Please start a new one.')
    }
    const updated = await activate(sub, shop.id)
    return json({
      ok: true,
      plan: updated.plan,
      plan_period: updated.plan_period,
      plan_expires_at: updated.plan_expires_at,
      subscription_status: updated.subscription_status
    })
  } catch (e) {
    return fail(e)
  }
})

// POST {}  (JWT required)
// Cancels the owner's Razorpay subscription at the end of the current cycle. Pro stays until plan_expires_at.
import { corsHeaders, fail, HttpError, json, ownerShop, rzp, Subscription, updateShop } from '../_shared/billing.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const { shop } = await ownerShop(req)
    const subId = shop.razorpay_subscription_id
    if (!subId) throw new HttpError(404, 'no_subscription', 'No subscription to cancel')

    const current = await rzp<Subscription>(`subscriptions/${encodeURIComponent(subId)}`)
    if (['cancelled', 'completed', 'expired'].includes(current.status)) {
      await updateShop(shop.id, { subscription_status: current.status })
      return json({ ok: true, subscription_status: current.status, plan_expires_at: shop.plan_expires_at })
    }
    // A subscription that was never paid cannot wait for a cycle end: cancel it right away.
    const atCycleEnd = ['active', 'authenticated', 'pending', 'halted'].includes(current.status) && !!current.current_end
    const sub = await rzp<Subscription>(`subscriptions/${encodeURIComponent(subId)}/cancel`, 'POST', {
      cancel_at_cycle_end: atCycleEnd ? 1 : 0
    })
    // With cancel_at_cycle_end Razorpay keeps status 'active' until the cycle ends; record our intent.
    const status = atCycleEnd ? 'cancelled' : sub.status || 'cancelled'
    await updateShop(shop.id, { subscription_status: status })
    return json({ ok: true, subscription_status: status, plan_expires_at: shop.plan_expires_at })
  } catch (e) {
    return fail(e)
  }
})

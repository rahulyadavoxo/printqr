// POST { period: 'monthly' | 'yearly' }  (JWT required)
// Creates a Razorpay subscription for the logged-in owner's shop.
// Returns { subscription_id, key_id } for Razorpay Checkout.
import { corsHeaders, fail, HttpError, isPro, json, ownerShop, Period, planId, PRICES, razorpayKeyId, rzp, updateShop } from '../_shared/billing.ts'

const ACTIVE = ['created', 'authenticated', 'active', 'pending']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const body = (await req.json().catch(() => ({}))) as { period?: string }
    const period = body.period as Period
    if (period !== 'monthly' && period !== 'yearly') throw new HttpError(400, 'bad_period', 'Choose monthly or yearly')

    const { shop, email } = await ownerShop(req)
    // Already paying and not cancelled: do not start a second subscription.
    if (isPro(shop) && shop.razorpay_subscription_id && ACTIVE.includes(shop.subscription_status || '')) {
      throw new HttpError(409, 'already_pro', 'Your Pro plan is already active')
    }

    const plan_id = await planId(period)
    const sub = await rzp<{ id: string; status: string }>('subscriptions', 'POST', {
      plan_id,
      total_count: PRICES[period].total_count,
      quantity: 1,
      customer_notify: 1,
      notes: { shop_id: shop.id, period, app: 'printqr', ...(email ? { email } : {}) }
    })

    // Remember the pending subscription only when the shop is not already Pro on another one.
    if (!isPro(shop)) {
      await updateShop(shop.id, { razorpay_subscription_id: sub.id, subscription_status: sub.status })
    }
    return json({ subscription_id: sub.id, key_id: razorpayKeyId() })
  } catch (e) {
    return fail(e)
  }
})

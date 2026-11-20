// POST { period: 'monthly' | 'yearly', tier?: 'pro' | 'plus' }  (JWT required)
// Creates a Razorpay subscription for the logged-in owner's shop.
// Returns { subscription_id, key_id } for Razorpay Checkout.
import { corsHeaders, db, fail, HttpError, isPro, json, ownerShop, Period, PLANS, planId, Tier, razorpayKeyId, rzp, updateShop } from '../_shared/billing.ts'

const ACTIVE = ['created', 'authenticated', 'active', 'pending']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const body = (await req.json().catch(() => ({}))) as { period?: string; tier?: string }
    const period = body.period as Period
    if (period !== 'monthly' && period !== 'yearly') throw new HttpError(400, 'bad_period', 'Choose monthly or yearly')
    const tier = (body.tier || 'pro') as Tier
    if (tier !== 'pro' && tier !== 'plus') throw new HttpError(400, 'bad_tier', 'Choose Pro or Plus')

    const { shop, email } = await ownerShop(req)
    // Plus needs the v16 database update (plan 'plus' allowed); check before any money moves.
    if (tier === 'plus') {
      await db('rpc/pro_counter_limit', { method: 'POST', body: '{}' }).catch(() => {
        throw new HttpError(409, 'needs_migration', 'Run supabase/migrations/2026-11-20-v16-plus.sql first')
      })
    }
    // Already paying and not cancelled: do not start a second subscription.
    // The one allowed exception: an active Pro shop upgrading to Plus (the old Pro subscription is cancelled on activation).
    const upgrading = tier === 'plus' && shop.plan === 'pro'
    if (!upgrading && isPro(shop) && shop.razorpay_subscription_id && ACTIVE.includes(shop.subscription_status || '')) {
      throw new HttpError(409, 'already_pro', 'Your Pro plan is already active')
    }

    const plan_id = await planId(period, tier)
    const sub = await rzp<{ id: string; status: string }>('subscriptions', 'POST', {
      plan_id,
      total_count: PLANS[tier][period].total_count,
      quantity: 1,
      customer_notify: 1,
      notes: { shop_id: shop.id, period, tier, app: 'printqr', ...(email ? { email } : {}) }
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

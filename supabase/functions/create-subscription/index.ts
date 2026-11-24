// POST { period: 'monthly' | 'yearly', tier?: 'pro' | 'plus', coupon?: string }  (JWT required)
// Creates a Razorpay subscription for the logged-in owner's shop.
// Returns { subscription_id, key_id, amount } for Razorpay Checkout.
//
// v40 % coupons (checked and applied here only; the browser never sends a price):
//   POST { preview: true, coupon }  -> { ok, kind, code, percent, mode, tiers, periods, prices } or { ok:false, error }
//   mode 'auto'  -> subscription on a discounted Razorpay plan (every cycle), notes carry tier, period, coupon, amount
//   mode 'offer' -> subscription on the normal plan with the code's Razorpay offer_id
// The code counts as used only after payment (verify-payment / webhook -> coupon_paid).
import { checkCoupon, corsHeaders, db, discountAmount, discountPlanId, fail, HttpError, isPro, json, ownerShop, paidEndMs, Period, PLANS, planId, Tier, razorpayKeyId, rzp, updateShop } from '../_shared/billing.ts'

const ACTIVE = ['created', 'authenticated', 'active', 'pending']

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
    const body = (await req.json().catch(() => ({}))) as { period?: string; tier?: string; coupon?: string; preview?: boolean }
    const couponCode = typeof body.coupon === 'string' ? body.coupon.trim().toUpperCase().slice(0, 30) : ''

    if (body.preview === true) {
      const { shop } = await ownerShop(req)
      if (!couponCode) throw new HttpError(400, 'coupon_not_found', 'This code is not valid')
      const c = await checkCoupon(shop.id, couponCode)
      if (!c.ok) return json({ ok: false, error: c.error })
      if (c.kind !== 'percent') return json({ ok: true, kind: c.kind, code: c.code, days: c.days })
      // Prices are worked out here from PLANS (paise). Offer mode: the discount is set in Razorpay, so the
      // normal price is shown and Razorpay Checkout shows the offer.
      const prices: Partial<Record<Tier, Partial<Record<Period, { base: number; amount: number }>>>> = {}
      for (const t of c.tiers || []) {
        for (const p of c.periods || []) {
          const base = PLANS[t][p].amount
          const amount = c.mode === 'auto' && c.percent ? discountAmount(base, c.percent) : base
          ;(prices[t] ||= {})[p] = { base, amount }
        }
      }
      return json({ ok: true, kind: 'percent', code: c.code, percent: c.percent, mode: c.mode, tiers: c.tiers, periods: c.periods, expires_at: c.expires_at, prices })
    }

    const period = body.period as Period
    if (period !== 'monthly' && period !== 'yearly') throw new HttpError(400, 'bad_period', 'Choose monthly or yearly')
    const tier = (body.tier || 'pro') as Tier
    if (tier !== 'pro' && tier !== 'plus') throw new HttpError(400, 'bad_tier', 'Choose Pro or Plus')

    const { shop, email, phone } = await ownerShop(req)
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

    // Pro bought while a cancelled Plus is still running (an active Plus was refused above): the Pro
    // cycle starts when the paid Plus period ends, so nothing is paid twice and Plus is not cut short.
    // activate() records it now and switches the shop to Pro when Razorpay starts it.
    let start_at: number | undefined
    if (tier === 'pro' && shop.plan === 'plus' && isPro(shop)) {
      const paidEnd = paidEndMs(shop)
      if (paidEnd > Date.now() + 15 * 60 * 1000) start_at = Math.floor(paidEnd / 1000)
    }

    // % coupon (v40): validated again here, server side, for this tier + period.
    let plan_id: string
    let amount = PLANS[tier][period].amount
    let offer_id: string | undefined
    let coupon: { code: string; mode: 'auto' | 'offer'; percent: number | null } | null = null
    if (couponCode) {
      const c = await checkCoupon(shop.id, couponCode)
      if (!c.ok) throw new HttpError(400, `coupon_${c.error}`, 'This code cannot be used')
      if (c.kind !== 'percent' || !c.mode) throw new HttpError(400, 'coupon_days', 'This code gives free days: use Apply')
      if (!(c.tiers || []).includes(tier) || !(c.periods || []).includes(period)) {
        throw new HttpError(400, 'coupon_not_for_plan', 'This code is not for this plan')
      }
      coupon = { code: c.code, mode: c.mode, percent: c.percent }
      if (c.mode === 'auto') {
        if (!c.percent) throw new HttpError(400, 'coupon_not_found', 'This code is not valid')
        const d = await discountPlanId(period, tier, c.percent)
        plan_id = d.plan_id
        amount = d.amount
      } else {
        if (!c.offer_id) throw new HttpError(400, 'coupon_not_found', 'This code is not valid')
        plan_id = await planId(period, tier)
        offer_id = c.offer_id
      }
    } else {
      plan_id = await planId(period, tier)
    }

    let sub: { id: string; status: string }
    try {
      sub = await rzp<{ id: string; status: string }>('subscriptions', 'POST', {
        plan_id,
        total_count: PLANS[tier][period].total_count,
        quantity: 1,
        customer_notify: 1,
        ...(start_at ? { start_at } : {}),
        ...(offer_id ? { offer_id } : {}),
        // No Razorpay customer is created here: email / phone only go in the notes (either may be missing).
        // tier + period always in the notes: periodOf / tierOf read them first (a discounted plan has its own price).
        notes: {
          shop_id: shop.id,
          period,
          tier,
          app: 'printqr',
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          ...(coupon ? { coupon: coupon.code, coupon_mode: coupon.mode, ...(coupon.percent ? { coupon_percent: String(coupon.percent) } : {}) } : {}),
          ...(coupon?.mode === 'auto' ? { amount: String(amount) } : {})
        }
      })
    } catch (e) {
      // Offer mode: Razorpay refuses an offer that is missing, expired or not linked to this plan.
      if (offer_id && e instanceof HttpError && e.code === 'razorpay_error') {
        console.warn('offer subscription', e.message)
        throw new HttpError(400, 'coupon_offer_failed', 'This code cannot be used right now')
      }
      throw e
    }

    if (coupon) {
      // Remembered for coupon_paid() after payment; also holds one of the code's uses for 30 minutes.
      try {
        await db('coupon_checkouts', {
          method: 'POST',
          body: JSON.stringify({ subscription_id: sub.id, code: coupon.code, shop_id: shop.id, tier, period, mode: coupon.mode,
            percent: coupon.percent, amount: coupon.mode === 'auto' ? amount : null, offer_id: offer_id || null }),
          prefer: 'return=minimal'
        })
      } catch (e) {
        // Not recorded = the code could not be counted after payment: drop the unpaid subscription instead.
        await rzp(`subscriptions/${encodeURIComponent(sub.id)}/cancel`, 'POST', { cancel_at_cycle_end: 0 }).catch((c) => console.warn('cancel unrecorded', c))
        throw e
      }
    }

    // Remember the pending subscription only when the shop is not already Pro on another one.
    if (!isPro(shop)) {
      await updateShop(shop.id, { razorpay_subscription_id: sub.id, subscription_status: sub.status })
    }
    return json({ subscription_id: sub.id, key_id: razorpayKeyId(), amount })
  } catch (e) {
    return fail(e)
  }
})

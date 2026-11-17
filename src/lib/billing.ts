import { supabase } from './supabase'

export type Period = 'monthly' | 'yearly'
export const PLAN_PRICES: Record<Period, number> = { monthly: 49, yearly: 539 }

type RazorpayResponse = { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }
type RazorpayOptions = {
  key: string
  subscription_id: string
  name: string
  description: string
  image?: string
  prefill?: { email?: string; contact?: string; name?: string }
  notes?: Record<string, string>
  theme?: { color: string }
  handler: (r: RazorpayResponse) => void
  modal?: { ondismiss?: () => void }
}
type RazorpayInstance = { open: () => void; on: (event: string, cb: (r: unknown) => void) => void }
declare global {
  interface Window {
    Razorpay?: new (o: RazorpayOptions) => RazorpayInstance
  }
}

let loading: Promise<void> | null = null
/** Razorpay Checkout is loaded from Razorpay's CDN only when the owner clicks Upgrade (no npm dependency). */
export function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve()
  if (loading) return loading
  loading = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      loading = null
      s.remove()
      reject(new Error('checkout_load_failed'))
    }
    document.head.appendChild(s)
  })
  return loading
}

/** Calls a billing Edge Function and returns its JSON; throws an Error with code + message on failure. */
export async function callFn<T>(name: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let code = 'server_error'
    let message = error.message || 'Something went wrong'
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = (await ctx.json()) as { error?: string; message?: string }
        if (j.error) code = j.error
        if (j.message) message = j.message
      } catch {
        /* not JSON */
      }
    } else if (/failed to send|fetch/i.test(message)) {
      code = 'not_deployed'
    }
    const e = new Error(message) as Error & { code?: string }
    e.code = code
    throw e
  }
  return data as T
}

/**
 * Full upgrade flow: create the subscription, open Razorpay Checkout, verify the payment.
 * Resolves true when Pro is on, false when the owner closed the checkout.
 */
export async function startUpgrade(period: Period, opts: { email?: string; description: string }): Promise<boolean> {
  const { subscription_id, key_id } = await callFn<{ subscription_id: string; key_id: string }>('create-subscription', { period })
  await loadRazorpay()
  if (!window.Razorpay) throw Object.assign(new Error('checkout_load_failed'), { code: 'checkout_load_failed' })
  const Razorpay = window.Razorpay
  return new Promise<boolean>((resolve, reject) => {
    const rz = new Razorpay({
      key: key_id,
      subscription_id,
      name: 'PrintQR',
      description: opts.description,
      image: `${window.location.origin}${import.meta.env.BASE_URL}icon-192.png`,
      prefill: opts.email ? { email: opts.email } : undefined,
      theme: { color: '#2348e0' },
      handler: (r) => {
        callFn('verify-payment', { ...r }).then(() => resolve(true), reject)
      },
      modal: { ondismiss: () => resolve(false) }
    })
    rz.open()
  })
}
